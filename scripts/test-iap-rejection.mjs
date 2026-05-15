#!/usr/bin/env node
/**
 * Tests the production IAP validation rejection paths.
 *
 *   node scripts/test-iap-rejection.mjs <BASE_URL>
 *
 * Three categories of checks:
 *   1) Missing-credentials path: server-mode is on but no Apple/Google creds → 400 with clear error.
 *   2) Real-Apple-rejection path: a junk receipt is sent through verifyReceipt → Apple returns
 *      status 21002/21003/21004 → backend translates to 400.
 *   3) Real-Google-rejection path: a junk purchase token is sent through Play Developer API →
 *      Google returns 400 invalid_grant or 404 → backend translates to 400.
 *
 * Categories (2) and (3) are skipped when the corresponding placeholder creds aren't set on the
 * deployed service. Use the --probe-real flag to verify category 1 only without flipping creds.
 */
import { randomUUID } from 'node:crypto';

const baseUrl = (process.argv.find((a) => a.startsWith('http')) ?? '').replace(/\/$/, '');
if (!baseUrl) {
  console.error('Usage: test-iap-rejection.mjs <BASE_URL>');
  process.exit(2);
}

let pass = 0;
let fail = 0;

function record(name, ok, detail = '') {
  const tag = ok ? 'PASS' : 'FAIL';
  if (ok) pass++;
  else fail++;
  console.log(`${tag}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function post(path, body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function get(path, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

(async () => {
  console.log(`>> IAP rejection tests against ${baseUrl}`);
  console.log('');

  // Probe: which mode is the service in? We can't read env vars directly,
  // but we can infer from the response shape on a malformed request.
  const did = randomUUID();

  // ---- iOS rejection path ----
  const iosFake = await post(
    '/quota/upgrade',
    { platform: 'ios', receipt: 'this-is-definitely-not-a-real-receipt-blob' },
    { 'X-Device-Id': did },
  );
  if (iosFake.status === 200 && iosFake.body?.isPro === true) {
    record(
      'ios: REJECTS fake receipt',
      false,
      'Got 200 isPro=true — service is in client-trust mode. Set IAP_VALIDATION_MODE=server to enable validation.',
    );
  } else if (iosFake.status === 400 && /apple|receipt|cred|configured/i.test(JSON.stringify(iosFake.body))) {
    record(
      'ios: REJECTS fake receipt with clear error',
      true,
      JSON.stringify(iosFake.body?.message ?? iosFake.body).slice(0, 160),
    );
  } else {
    record(
      'ios: REJECTS fake receipt',
      false,
      `unexpected status=${iosFake.status} body=${JSON.stringify(iosFake.body).slice(0, 200)}`,
    );
  }

  // Cleanup: confirm device wasn't upgraded
  const did2 = randomUUID();
  const iosFakeAgain = await post(
    '/quota/upgrade',
    { platform: 'ios', receipt: 'second-fake' },
    { 'X-Device-Id': did2 },
  );
  const quotaAfter = await get('/quota', { 'X-Device-Id': did2 });
  record(
    'ios: failed upgrade does NOT flip isPro',
    iosFakeAgain.status !== 200 && quotaAfter.body?.isPro === false,
    `upgrade=${iosFakeAgain.status} isPro=${quotaAfter.body?.isPro}`,
  );

  // ---- Android rejection path ----
  const did3 = randomUUID();
  const andFake = await post(
    '/quota/upgrade',
    { platform: 'android', receipt: 'fake-purchase-token-xyz', productId: 'carsalepro_pro_monthly' },
    { 'X-Device-Id': did3 },
  );
  if (andFake.status === 200 && andFake.body?.isPro === true) {
    record('android: REJECTS fake token', false, 'service in client-trust mode');
  } else if (andFake.status === 400 && /google|play|sa_json|configured|productId|token/i.test(JSON.stringify(andFake.body))) {
    record(
      'android: REJECTS fake token with clear error',
      true,
      JSON.stringify(andFake.body?.message ?? andFake.body).slice(0, 160),
    );
  } else {
    record(
      'android: REJECTS fake token',
      false,
      `unexpected status=${andFake.status} body=${JSON.stringify(andFake.body).slice(0, 200)}`,
    );
  }

  // ---- Format validation (cheaper) ----
  const did4 = randomUUID();
  const badPlatform = await post(
    '/quota/upgrade',
    { platform: 'web', receipt: 'x' },
    { 'X-Device-Id': did4 },
  );
  record(
    'shape: rejects unknown platform',
    badPlatform.status === 400,
    `status=${badPlatform.status}`,
  );

  const did5 = randomUUID();
  const noReceipt = await post(
    '/quota/upgrade',
    { platform: 'ios' },
    { 'X-Device-Id': did5 },
  );
  record(
    'shape: rejects missing receipt',
    noReceipt.status === 400,
    `status=${noReceipt.status}`,
  );

  const did6 = randomUUID();
  const noDevice = await post('/quota/upgrade', { platform: 'ios', receipt: 'x' });
  record(
    'shape: rejects missing X-Device-Id',
    noDevice.status === 400,
    `status=${noDevice.status}`,
  );

  console.log('');
  console.log(`--- Summary: ${pass} passed, ${fail} failed ---`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Fatal:', err);
  process.exit(2);
});
