import http from 'k6/http';
import { check, fail, group, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';
import exec from 'k6/execution';
import papaparse from 'https://jslib.k6.io/papaparse/5.1.1/index.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------
const BASE_URL = (__ENV.BASE_URL || 'https://staging.cityfinance.in').replace(/\/$/, '');
const FC_TYPE = __ENV.FC_TYPE || '16thFC';
const VUS = Number(__ENV.VUS || 1);
const FILE_DELAY_SECONDS = Number(__ENV.FILE_DELAY_SECONDS || 1);

// Change only when your actual API paths are different.
const LOGIN_PATH = __ENV.LOGIN_PATH || '/api/v1/login';
const GET_S3_URL_PATH = __ENV.GET_S3_URL_PATH || '/api/v1/getS3Url';

// -----------------------------------------------------------------------------
// Metrics
// -----------------------------------------------------------------------------
const loginDuration = new Trend('login_duration', true);
const getUrlDuration = new Trend('get_s3url_duration', true);
const s3UploadDuration = new Trend('s3_upload_duration', true);
const uploadsOk = new Counter('uploads_successful');
const uploadsFail = new Counter('uploads_failed');

// -----------------------------------------------------------------------------
// Test users
// -----------------------------------------------------------------------------
const users = new SharedArray('users', () => {
  const parsed = papaparse.parse(open('./users.csv'), {
    header: true,
    skipEmptyLines: true,
  });

  return parsed.data.filter((user) => user.email && user.password);
});

// -----------------------------------------------------------------------------
// Seven PDF files
// open() must run in the init context, so each file is declared here.
// Replace these files with your real test PDFs.
// -----------------------------------------------------------------------------
const uploadFiles = [
  { localPath: './files/file1.pdf', originalName: 'file1.pdf', data: open('./files/file1.pdf', 'b') },
  { localPath: './files/file2.pdf', originalName: 'file2.pdf', data: open('./files/file2.pdf', 'b') },
  { localPath: './files/file3.pdf', originalName: 'file3.pdf', data: open('./files/file3.pdf', 'b') },
  { localPath: './files/file4.pdf', originalName: 'file4.pdf', data: open('./files/file4.pdf', 'b') },
  { localPath: './files/file5.pdf', originalName: 'file5.pdf', data: open('./files/file5.pdf', 'b') },
  { localPath: './files/file6.pdf', originalName: 'file6.pdf', data: open('./files/file6.pdf', 'b') },
  { localPath: './files/file7.pdf', originalName: 'file7.pdf', data: open('./files/file7.pdf', 'b') },
];

if (!Number.isInteger(VUS) || VUS < 1) {
  throw new Error('VUS must be a positive whole number.');
}
if (VUS > users.length) {
  throw new Error(`VUS=${VUS}, but users.csv contains only ${users.length} valid users.`);
}

// -----------------------------------------------------------------------------
// Scenario
// One VU uses one CSV account, logs in once, and uploads all seven PDFs once.
// -----------------------------------------------------------------------------
export const options = {
  scenarios: {
    upload_seven_files_per_user: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '30m',
    },
  },
  thresholds: {
    login_duration: ['p(95)<3000'],
    get_s3url_duration: ['p(95)<3000'],
    s3_upload_duration: ['p(95)<30000'],
    http_req_failed: ['rate<0.05'],
    uploads_failed: ['count<1'],
  },
};

function extractToken(response) {
  const body = response.json();
  return (
    body.token ||
    body.accessToken ||
    body.access_token ||
    body.id_token ||
    (body.data && (body.data.token || body.data.accessToken || body.data.access_token)) ||
    ''
  );
}

function login(user) {
  const response = http.post(
    `${BASE_URL}${LOGIN_PATH}`,
    JSON.stringify({
      email: user.email,
      password: user.password,
      type: FC_TYPE,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      tags: {
        name: 'POST login',
        request_type: 'login',
      },
      timeout: '60s',
    }
  );

  loginDuration.add(response.timings.duration);

  const loginOk = check(response, {
    'login status is 200': (res) => res.status === 200,
    'login response is JSON': (res) => {
      try {
        res.json();
        return true;
      } catch (_) {
        return false;
      }
    },
  });

  if (!loginOk) {
    console.error(
      `VU ${__VU}: login failed for ${user.email}; status=${response.status}; ` +
      `body=${String(response.body).slice(0, 500)}`
    );
    fail('Login failed. Upload steps were stopped for this user.');
  }

  const token = extractToken(response);

  if (!token) {
    console.error(
      `VU ${__VU}: token was not found in the login response for ${user.email}. ` +
      `Response keys=${Object.keys(response.json()).join(', ')}`
    );
    fail('No authentication token was found.');
  }

  return token;
}

function uploadOnePdf(user, token, fileItem, fileNumber) {
  const safeUser = user.email.replace(/[^a-zA-Z0-9]/g, '_');
  const uniqueFileName =
    `loadtest_${safeUser}_vu${__VU}_iter${__ITER}_file${fileNumber}_${Date.now()}.pdf`;

  // Step A: request a presigned S3 URL from CityFinance.
  const s3UrlResponse = http.post(
    `${BASE_URL}${GET_S3_URL_PATH}`,
    JSON.stringify([
      {
        folder: 'loadtest',
        file_name: uniqueFileName,
        mime_type: 'application/pdf',
      },
    ]),
    {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-access-token': token,
      },
      tags: {
        name: 'POST getS3Url',
        request_type: 'get_s3_url',
        file_number: String(fileNumber),
      },
      timeout: '60s',
    }
  );

  getUrlDuration.add(s3UrlResponse.timings.duration);

  const urlOk = check(s3UrlResponse, {
    [`file ${fileNumber}: getS3Url status is 200`]: (res) => res.status === 200,
    [`file ${fileNumber}: presigned URL is present`]: (res) => {
      try {
        const body = res.json();
        return Array.isArray(body) && body[0] && typeof body[0].url === 'string';
      } catch (_) {
        return false;
      }
    },
  });

  if (!urlOk) {
    uploadsFail.add(1);
    console.error(
      `VU ${__VU}: getS3Url failed for file ${fileNumber}; ` +
      `status=${s3UrlResponse.status}; body=${String(s3UrlResponse.body).slice(0, 500)}`
    );
    return;
  }

  const presignedUrl = s3UrlResponse.json()[0].url;

  // Step B: PUT the PDF binary directly to S3.
  const uploadResponse = http.put(presignedUrl, fileItem.data, {
    headers: {
      'Content-Type': 'application/pdf',
    },
    tags: {
      name: 'PUT S3 upload',
      request_type: 's3_upload',
      file_number: String(fileNumber),
    },
    timeout: '180s',
  });

  s3UploadDuration.add(uploadResponse.timings.duration);

  const uploadOk = check(uploadResponse, {
    [`file ${fileNumber}: S3 upload status is successful`]: (res) =>
      [200, 201, 204].includes(res.status),
  });

  if (uploadOk) {
    uploadsOk.add(1);
    console.log(
      `VU ${__VU}: uploaded file ${fileNumber}/7 successfully as ${uniqueFileName}`
    );
  } else {
    uploadsFail.add(1);
    console.error(
      `VU ${__VU}: S3 upload failed for file ${fileNumber}; ` +
      `status=${uploadResponse.status}; body=${String(uploadResponse.body).slice(0, 500)}`
    );
  }
}

export default function () {
  const userIndex = exec.vu.idInTest - 1;
  const user = users[userIndex];

  if (!user) {
    fail(`No CSV user is available for VU ${exec.vu.idInTest}.`);
  }

  group('01 - Login', () => {
    const token = login(user);
    sleep(1);

    group('02 - Upload seven PDFs sequentially', () => {
      uploadFiles.forEach((fileItem, index) => {
        uploadOnePdf(user, token, fileItem, index + 1);

        if (index < uploadFiles.length - 1 && FILE_DELAY_SECONDS > 0) {
          sleep(FILE_DELAY_SECONDS);
        }
      });
    });
  });
}

export function handleSummary(data) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  return {
    stdout: textSummary(data, { indent: '  ', enableColors: true }),
    [`k6-upload-summary-${timestamp}.json`]: JSON.stringify(data, null, 2),
  };
}
