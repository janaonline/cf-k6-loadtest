import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'https://dev.cityfinance.in';
const ULB_ID = __ENV.ULB_ID || '802918';
const PASSWORD = __ENV.PASSWORD || 'ulb@123';
const FC_TYPE = __ENV.FC_TYPE || '16thFC';
const ULB_OBJECT_ID = __ENV.ULB_OBJECT_ID || '5eb5844f76a3b61f40ba069a';
const STATE_ID = __ENV.STATE_ID || '5dcf9d7516a06aed41c748fb';
const DESIGN_YEAR_ID = __ENV.DESIGN_YEAR_ID || '67d7d136d3d038946a5239e9';
const DOCUMENT_YEAR_ID = __ENV.DOCUMENT_YEAR_ID || '606aafcf4dff55e6c075d424';
const FINANCIAL_YEAR = __ENV.FY || '2024-25';
const SECTION = __ENV.SECTION || 'auditedData';
const AUDIT_TYPE = (__ENV.AUDIT_TYPE || 'AUDITED').toUpperCase();
const FILE_GAP_SECONDS = Number(__ENV.FILE_GAP || 0);
const VUS = Number(__ENV.VUS || 10);
const ITERATIONS_PER_VU = Number(__ENV.ITERATIONS_PER_VU || 1);
const MAX_RETRIES = Number(__ENV.MAX_RETRIES || 8);
const RETRY_BASE_SECONDS = Number(__ENV.RETRY_BASE_SECONDS || 0.5);
const RETRY_MAX_SECONDS = Number(__ENV.RETRY_MAX_SECONDS || 5);
const USE_USER_STAGGER = __ENV.USER_STAGGER_SECONDS !== undefined;
const USER_STAGGER_SECONDS = Number(__ENV.USER_STAGGER_SECONDS || 0);
const START_SPREAD_SECONDS = Number(
  __ENV.START_SPREAD_SECONDS === undefined
    ? (VUS >= 100 ? 30 : 0)
    : __ENV.START_SPREAD_SECONDS,
);

// Files are loaded once during k6 init. Keep this JS file and all PDFs in the same folder.
const DOCUMENTS = [
  {
    label: 'Receipts and Payments Statement',
    fileName: '11.pdf',
    data: open('./11.pdf', 'b'),
    documentType: 'receipts-and-payments-statement',
  },
  {
    label: 'Balance Sheet',
    fileName: '22.pdf',
    data: open('./22.pdf', 'b'),
    documentType: 'balance-sheet',
  },
  {
    label: 'Balance Sheet Schedules',
    fileName: '33.pdf',
    data: open('./33.pdf', 'b'),
    documentType: 'balance-sheet-schedules',
  },
  {
    label: 'Income and Expenditure Statement',
    fileName: '44.pdf',
    data: open('./44.pdf', 'b'),
    documentType: 'income-expenditure',
  },
  {
    label: 'Income Statement Schedules',
    fileName: '55(1).pdf',
    data: open('./55(1).pdf', 'b'),
    documentType: 'income-statement-schedules',
  },
  {
    label: 'Cash Flow Statement',
    fileName: '66.pdf',
    data: open('./66.pdf', 'b'),
    documentType: 'cash-flow',
  },
  {
    label: 'Additional Annual Account Document',
    fileName: '7.pdf',
    data: open('./7.pdf', 'b'),
    // The confirm API currently supports the six annual-account docIds above.
    // Use a supported category for the additional physical test file.
    documentType: __ENV.SEVENTH_DOCUMENT_TYPE || 'cash-flow',
  },
];

if (!Number.isInteger(VUS) || VUS < 1) {
  throw new Error(`VUS must be a positive integer; received "${__ENV.VUS}".`);
}

if (!Number.isInteger(ITERATIONS_PER_VU) || ITERATIONS_PER_VU < 1) {
  throw new Error(
    `ITERATIONS_PER_VU must be a positive integer; received "${__ENV.ITERATIONS_PER_VU}".`,
  );
}

if (!Number.isFinite(FILE_GAP_SECONDS) || FILE_GAP_SECONDS < 0) {
  throw new Error(`FILE_GAP must be a non-negative number; received "${__ENV.FILE_GAP}".`);
}

if (!Number.isInteger(MAX_RETRIES) || MAX_RETRIES < 0) {
  throw new Error(`MAX_RETRIES must be a non-negative integer; received "${__ENV.MAX_RETRIES}".`);
}

if (!['AUDITED', 'UNAUDITED'].includes(AUDIT_TYPE)) {
  throw new Error(`AUDIT_TYPE must be AUDITED or UNAUDITED; received "${__ENV.AUDIT_TYPE}".`);
}

for (const [name, value] of [
  ['RETRY_BASE_SECONDS', RETRY_BASE_SECONDS],
  ['RETRY_MAX_SECONDS', RETRY_MAX_SECONDS],
  ['USER_STAGGER_SECONDS', USER_STAGGER_SECONDS],
  ['START_SPREAD_SECONDS', START_SPREAD_SECONDS],
]) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number; received "${__ENV[name]}".`);
  }
}

export const options = {
  scenarios: {
    same_ulb_concurrent_login_and_upload: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: ITERATIONS_PER_VU,
      maxDuration: __ENV.MAX_DURATION || '15m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    login_failed: ['rate<0.05'],
    signed_url_failed: ['rate<0.05'],
    storage_upload_failed: ['rate<0.05'],
    confirm_upload_failed: ['rate<0.05'],
    iteration_success: ['rate==1'],
    login_duration: ['p(95)<3000'],
    confirm_upload_duration: ['p(95)<5000'],
  },
};

const loginFailed = new Rate('login_failed');
const signedUrlFailed = new Rate('signed_url_failed');
const storageUploadFailed = new Rate('storage_upload_failed');
const confirmUploadFailed = new Rate('confirm_upload_failed');
const iterationSuccess = new Rate('iteration_success');
const documentsUploaded = new Counter('documents_uploaded');
const storageRetryAttempts = new Counter('storage_retry_attempts');
const confirmRetryAttempts = new Counter('confirm_retry_attempts');

const loginDuration = new Trend('login_duration', true);
const signedUrlDuration = new Trend('signed_url_duration', true);
const storageUploadDuration = new Trend('storage_upload_duration', true);
const confirmUploadDuration = new Trend('confirm_upload_duration', true);

function apiHeaders(token) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function safeJson(res) {
  try {
    return res.json();
  } catch (_) {
    return null;
  }
}

function uuidV4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    const nibble = char === 'x' ? value : (value & 0x3) | 0x8;
    return nibble.toString(16);
  });
}

function retryDelay(attempt) {
  const exponentialDelay = Math.min(
    RETRY_BASE_SECONDS * (2 ** attempt),
    RETRY_MAX_SECONDS,
  );
  return exponentialDelay * (0.75 + Math.random() * 0.5);
}

function isRetryableStatus(status) {
  return status === 0 || status === 408 || status === 409 || status === 429 || status >= 500;
}

function extractAccessToken(loginRes) {
  const body = safeJson(loginRes);
  return (
    body?.accessToken ||
    body?.token ||
    body?.data?.accessToken ||
    body?.data?.access_token ||
    body?.data?.token ||
    body?.result?.accessToken ||
    body?.result?.token ||
    null
  );
}

function extractSignedUrlInfo(res) {
  const body = safeJson(res);
  const responseData = body?.data || body?.result || body || {};
  const d = Array.isArray(responseData) ? responseData[0] || {} : responseData;

  return {
    body,
    // Common response field names; one of these should match your API response.
    uploadUrl:
      d.signedUrl ||
      d.signedURL ||
      d.uploadUrl ||
      d.uploadURL ||
      d.url ||
      d.presignedUrl ||
      d.preSignedUrl ||
      null,
    key:
      d.key ||
      d.fileKey ||
      d.objectKey ||
      d.s3Key ||
      d.path ||
      d.filePath ||
      null,
    fileId: d.fileId || d.id || d._id || null,
  };
}

function login() {
  const payload = JSON.stringify({
    identifier: ULB_ID,
    password: PASSWORD,
    type: FC_TYPE,
    recaptchaToken: '',
  });

  const res = http.post(`${BASE_URL}/api/v2/auth/login`, payload, {
    headers: apiHeaders(),
    tags: { name: 'POST /api/v2/auth/login' },
  });

  loginDuration.add(res.timings.duration);
  const token = extractAccessToken(res);

  const ok = check(res, {
    'login status is 200': (r) => r.status === 200,
    'login access token found': () => Boolean(token),
  });

  loginFailed.add(!ok);

  if (!ok) {
    const body = safeJson(res);
    console.error(
      `VU ${__VU}: login failed. status=${res.status}; response keys=${body ? Object.keys(body).join(',') : 'non-JSON'}`,
    );
    return null;
  }

  return token;
}

function buildSignedUrlPayload(doc, uploadId) {
  return [{
    fileName: doc.fileName,
    folder: `xvi-fc/annual-accounts/${ULB_OBJECT_ID}/${DESIGN_YEAR_ID}/${SECTION}/${doc.documentType}`,
    mimeType: 'application/pdf',
    uploadId,
    expiresIn: 300,
  }];
}

function requestSignedUrl(token, doc) {
  const uploadId = uuidV4();
  const payload = JSON.stringify(buildSignedUrlPayload(doc, uploadId));
  let res;
  let signed;
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    res = http.post(
      `${BASE_URL}/api/v2/file/signed-url`,
      payload,
      {
        headers: apiHeaders(token),
        tags: {
          name: 'POST /api/v2/file/signed-url',
          document: doc.label,
          attempt: String(attempt + 1),
        },
      },
    );

    signedUrlDuration.add(res.timings.duration);
    signed = extractSignedUrlInfo(res);
    if ((res.status === 200 || res.status === 201) && signed.uploadUrl) break;
    if (attempt === MAX_RETRIES || !isRetryableStatus(res.status)) break;

    sleep(retryDelay(attempt));
    attempt += 1;
  }

  const ok = check(res, {
    'signed-url status is 200/201': (r) => r.status === 200 || r.status === 201,
    'signed upload URL found': () => Boolean(signed.uploadUrl),
  });

  signedUrlFailed.add(!ok);

  if (!ok) {
    const body = safeJson(res);
    console.error(
      `VU ${__VU}: signed-url failed for ${doc.fileName} after ${attempt + 1} attempts. status=${res.status}; response keys=${body ? Object.keys(body).join(',') : 'non-JSON'}`,
    );
    return null;
  }

  return { ...signed, uploadId };
}

function uploadPdfToStorage(doc, signed) {
  let res;
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    // Do not send the CityFinance Bearer token to the signed storage URL.
    res = http.put(signed.uploadUrl, doc.data, {
      headers: {
        'Content-Type': 'application/pdf',
      },
      tags: {
        name: 'PUT signed storage URL',
        document: doc.label,
        attempt: String(attempt + 1),
      },
    });

    storageUploadDuration.add(res.timings.duration);

    if (res.status === 200 || res.status === 201 || res.status === 204) break;
    if (attempt === MAX_RETRIES || !isRetryableStatus(res.status)) break;

    storageRetryAttempts.add(1);
    sleep(retryDelay(attempt));
    attempt += 1;
  }

  const ok = check(res, {
    'storage upload status is 200/201/204': (r) =>
      r.status === 200 || r.status === 201 || r.status === 204,
  });

  storageUploadFailed.add(!ok);

  if (!ok) {
    console.error(
      `VU ${__VU}: binary upload failed for ${doc.fileName} after ${attempt + 1} attempts. status=${res.status}`,
    );
  }

  return ok;
}

function buildConfirmUploadPayload(doc, signed) {
  return {
    uploadId: signed.uploadId,
    s3Key: signed.key,
    ulbId: ULB_OBJECT_ID,
    stateId: STATE_ID,
    designYearId: DESIGN_YEAR_ID,
    section: SECTION,
    auditType: AUDIT_TYPE,
    docId: doc.documentType,
    yearId: DOCUMENT_YEAR_ID,
    year: FINANCIAL_YEAR,
    originalName: doc.fileName,
    fileSize: doc.data.byteLength,
  };
}

function confirmUpload(token, doc, signed) {
  let res;
  let attempt = 0;
  const payload = JSON.stringify(buildConfirmUploadPayload(doc, signed));

  while (attempt <= MAX_RETRIES) {
    res = http.post(
      `${BASE_URL}/api/v2/xvi-fc/annual-account/confirm-upload`,
      payload,
      {
        headers: apiHeaders(token),
        tags: {
          name: 'POST /api/v2/xvi-fc/annual-account/confirm-upload',
          document: doc.label,
          attempt: String(attempt + 1),
        },
        // A conflict is an expected transient response during same-ULB contention.
        responseCallback: http.expectedStatuses(200, 201, 409, 429),
      },
    );

    confirmUploadDuration.add(res.timings.duration);

    if (res.status === 200 || res.status === 201) break;
    if (attempt === MAX_RETRIES || !isRetryableStatus(res.status)) break;

    confirmRetryAttempts.add(1);
    sleep(retryDelay(attempt));
    attempt += 1;
  }

  const ok = check(res, {
    'confirm-upload status is 200/201': (r) => r.status === 200 || r.status === 201,
  });

  confirmUploadFailed.add(!ok);

  if (!ok) {
    const body = safeJson(res);
    console.error(
      `VU ${__VU}: confirm-upload failed for ${doc.fileName} after ${attempt + 1} attempts. status=${res.status}; response=${body ? JSON.stringify(body).slice(0, 500) : 'non-JSON'}`,
    );
  } else {
    documentsUploaded.add(1);
  }

  return ok;
}

export default function () {
  let token;
  let allDocumentsSucceeded = true;

  if (USE_USER_STAGGER && USER_STAGGER_SECONDS > 0) {
    sleep((__VU - 1) * USER_STAGGER_SECONDS);
  } else if (!USE_USER_STAGGER && START_SPREAD_SECONDS > 0 && VUS > 1) {
    const scheduledDelay = ((__VU - 1) / (VUS - 1)) * START_SPREAD_SECONDS;
    sleep(scheduledDelay + Math.random() * 0.1);
  }

  group('1. Login', () => {
    token = login();
  });

  if (!token) {
    iterationSuccess.add(false);
    return;
  }

  group(`2. Upload all ${DOCUMENTS.length} annual-account PDFs`, () => {
    for (const doc of DOCUMENTS) {
      const signed = requestSignedUrl(token, doc);
      if (!signed) {
        allDocumentsSucceeded = false;
        continue;
      }

      const uploaded = uploadPdfToStorage(doc, signed);
      if (!uploaded) {
        allDocumentsSucceeded = false;
        continue;
      }

      if (!confirmUpload(token, doc, signed)) {
        allDocumentsSucceeded = false;
      }

      if (FILE_GAP_SECONDS > 0) sleep(FILE_GAP_SECONDS);
    }
  });

  iterationSuccess.add(allDocumentsSucceeded);
}

function summaryMetric(data, metricName, valueName) {
  return data.metrics[metricName]?.values?.[valueName] || 0;
}

function formatDuration(value) {
  return `${Number(value || 0).toFixed(2)} ms`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildHtmlReport(data, generatedAt) {
  const thresholdResults = [];

  for (const [metricName, metric] of Object.entries(data.metrics)) {
    for (const [expression, result] of Object.entries(metric.thresholds || {})) {
      thresholdResults.push({
        metricName,
        expression,
        passed: result.ok === true,
      });
    }
  }

  const allThresholdsPassed = thresholdResults.every((result) => result.passed);
  const totalFilesPlanned = VUS * ITERATIONS_PER_VU * DOCUMENTS.length;
  const documentsConfirmed = summaryMetric(data, 'documents_uploaded', 'count');
  const metricCards = [
    ['Total users', VUS],
    ['Files per user', DOCUMENTS.length * ITERATIONS_PER_VU],
    ['Total files planned', totalFilesPlanned],
    ['Documents confirmed', documentsConfirmed],
    ['Documents failed', Math.max(totalFilesPlanned - documentsConfirmed, 0)],
    ['Successful user iterations', summaryMetric(data, 'iteration_success', 'passes')],
  ];
  const latencyRows = [
    ['Login', 'login_duration'],
    ['Signed URL', 'signed_url_duration'],
    ['Storage upload', 'storage_upload_duration'],
    ['Confirm upload', 'confirm_upload_duration'],
    ['All HTTP requests', 'http_req_duration'],
  ];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CityFinance upload test report</title>
  <style>
    :root { color-scheme: light; font-family: Arial, sans-serif; color: #182230; background: #f4f6f8; }
    body { margin: 0; }
    main { width: min(1100px, calc(100% - 32px)); margin: 32px auto; }
    header { border-left: 6px solid ${allThresholdsPassed ? '#16803c' : '#c62828'}; padding: 4px 0 4px 18px; }
    h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: 0; }
    h2 { margin-top: 32px; font-size: 19px; letter-spacing: 0; }
    p { margin: 4px 0; color: #52606d; }
    .status { color: ${allThresholdsPassed ? '#16803c' : '#c62828'}; font-weight: 700; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-top: 24px; }
    .metric { background: #fff; border: 1px solid #d9e0e7; border-radius: 6px; padding: 16px; }
    .metric span { display: block; color: #52606d; font-size: 13px; }
    .metric strong { display: block; margin-top: 8px; font-size: 24px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d9e0e7; }
    th, td { padding: 11px 12px; border-bottom: 1px solid #e6ebf0; text-align: left; }
    th { background: #eef2f5; font-size: 13px; }
    td { font-size: 14px; }
    .pass { color: #16803c; font-weight: 700; }
    .fail { color: #c62828; font-weight: 700; }
    @media (max-width: 600px) { main { width: min(100% - 20px, 1100px); margin: 18px auto; } th, td { padding: 8px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>CityFinance upload test report</h1>
      <p>Generated: ${escapeHtml(generatedAt.toISOString())}</p>
      <p class="status">${allThresholdsPassed ? 'All thresholds passed' : 'One or more thresholds failed'}</p>
    </header>
    <section class="metrics">
      ${metricCards.map(([label, value]) => `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}
    </section>
    <h2>Latency</h2>
    <table>
      <thead><tr><th>Request stage</th><th>Average</th><th>p95</th><th>Maximum</th></tr></thead>
      <tbody>
        ${latencyRows.map(([label, metricName]) => `<tr><td>${escapeHtml(label)}</td><td>${formatDuration(summaryMetric(data, metricName, 'avg'))}</td><td>${formatDuration(summaryMetric(data, metricName, 'p(95)'))}</td><td>${formatDuration(summaryMetric(data, metricName, 'max'))}</td></tr>`).join('')}
      </tbody>
    </table>
    <h2>Thresholds</h2>
    <table>
      <thead><tr><th>Metric</th><th>Requirement</th><th>Result</th></tr></thead>
      <tbody>
        ${thresholdResults.map((result) => `<tr><td>${escapeHtml(result.metricName)}</td><td>${escapeHtml(result.expression)}</td><td class="${result.passed ? 'pass' : 'fail'}">${result.passed ? 'PASS' : 'FAIL'}</td></tr>`).join('')}
      </tbody>
    </table>
  </main>
</body>
</html>`;
}

export function handleSummary(data) {
  const uploads = data.metrics.documents_uploaded?.values || {};
  const successfulIterations = data.metrics.iteration_success?.values || {};
  const generatedAt = new Date();
  const reportId = generatedAt.toISOString().replace(/[:.]/g, '-');
  const archiveBase = `reports/cityfinance-upload-${VUS}-users-${reportId}`;
  const jsonReport = JSON.stringify(data, null, 2);
  const htmlReport = buildHtmlReport(data, generatedAt);
  const totalFilesPlanned = VUS * ITERATIONS_PER_VU * DOCUMENTS.length;
  const documentsConfirmed = uploads.count || 0;
  const documentsFailed = Math.max(totalFilesPlanned - documentsConfirmed, 0);
  const completedIterations = successfulIterations.passes || 0;
  const expectedIterations = VUS * ITERATIONS_PER_VU;
  const functionalResult =
    documentsConfirmed === totalFilesPlanned && completedIterations === expectedIterations
      ? 'PASS'
      : 'FAIL';

  const consoleSummary = [
    '',
    '============================================================',
    '             CITYFINANCE FILE UPLOAD SUMMARY',
    '============================================================',
    `  Total users:                 ${VUS}`,
    `  Files per user:              ${DOCUMENTS.length * ITERATIONS_PER_VU}`,
    `  Total files planned:         ${totalFilesPlanned}`,
    `  Documents confirmed:         ${documentsConfirmed}`,
    `  Documents failed:            ${documentsFailed}`,
    `  Successful user iterations:  ${completedIterations}/${expectedIterations}`,
    `  Overall functional result:   ${functionalResult}`,
    '============================================================',
    `  HTML report: ${archiveBase}.html`,
    `  JSON report: ${archiveBase}.json`,
    '',
  ].join('\n');

  return {
    stdout: consoleSummary,
    'summary.json': jsonReport,
    'report.html': htmlReport,
    [`${archiveBase}.json`]: jsonReport,
    [`${archiveBase}.html`]: htmlReport,
  };
}
