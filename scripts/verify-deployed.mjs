#!/usr/bin/env node
/**
 * CarSalePro backend smoke-tester.
 *
 *   node scripts/verify-deployed.mjs <BASE_URL> [--vin=1HGBH41JXMN109186]
 *
 * Exits non-zero on the first FAIL. Designed to be run both locally
 * (BASE_URL=http://localhost:3000) and against the deployed Render URL.
 */
import { randomUUID, createHash } from 'node:crypto';

const args = process.argv.slice(2);
const baseUrl = (args.find((a) => !a.startsWith('--')) ?? process.env.BASE_URL ?? '').replace(
  /\/$/,
  '',
);
const sampleVin = (args.find((a) => a.startsWith('--vin=')) ?? '--vin=1HGBH41JXMN109186').split(
  '=',
)[1];

if (!baseUrl) {
  console.error('Usage: verify-deployed.mjs <BASE_URL>');
  process.exit(2);
}

let failures = 0;
let passes = 0;

function record(name, ok, detail = '') {
  if (ok) {
    passes++;
    console.log(`PASS  ${name}${detail ? '  — ' + detail : ''}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? '  — ' + detail : ''}`);
  }
}

async function jsonFetch(method, path, { body, headers, raw = false } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (raw) return { status: res.status, body: parsed, headers: res.headers };
  return { status: res.status, body: parsed };
}

(async () => {
  console.log(`>> Verifying ${baseUrl}`);
  console.log('');

  // 1. Health
  const health = await jsonFetch('GET', '/health');
  record('health: 200 + db up', health.status === 200 && health.body?.info?.database?.status === 'up', JSON.stringify(health.body?.info ?? health.body));
  const r2Up = health.body?.info?.r2?.status === 'up';

  // 2. Swagger
  const docsRes = await fetch(`${baseUrl}/docs`);
  const docsText = await docsRes.text();
  record(
    'docs: Swagger UI HTML',
    docsRes.status === 200 && /swagger/i.test(docsText),
    `status=${docsRes.status} size=${docsText.length}`,
  );

  // 2b. Legal pages (privacy + terms, localized HTML)
  const legalIndex = await jsonFetch('GET', '/legal');
  record(
    'legal: JSON index has privacy + terms in 3 langs',
    legalIndex.status === 200 &&
      ['de', 'en', 'ru'].every((l) => legalIndex.body?.privacy?.[l] && legalIndex.body?.terms?.[l]),
    JSON.stringify(legalIndex.body?.updatedAt),
  );
  const privacyEn = await fetch(`${baseUrl}/legal/privacy?lang=en`);
  const privacyText = await privacyEn.text();
  record(
    'legal: privacy HTML states permanent retention',
    privacyEn.status === 200 && /text\/html/.test(privacyEn.headers.get('content-type') ?? '') &&
      /permanent|forever/i.test(privacyText),
    `status=${privacyEn.status} size=${privacyText.length}`,
  );

  // 2c. Catalog reference data
  const catalog = await jsonFetch('GET', '/catalog');
  record(
    'catalog: 68 K/S/T codes + 98 checklist items + 8+ angles',
    catalog.status === 200 &&
      catalog.body?.kstCodes?.length === 68 &&
      catalog.body?.checklist?.length === 98 &&
      catalog.body?.angles?.length >= 8,
    `v=${catalog.body?.version} codes=${catalog.body?.kstCodes?.length} checklist=${catalog.body?.checklist?.length}`,
  );
  const catalogVersion = catalog.body?.version;
  if (catalogVersion) {
    const upToDate = await jsonFetch('GET', `/catalog?version=${catalogVersion}`);
    record(
      'catalog: version match returns upToDate',
      upToDate.status === 200 && upToDate.body?.upToDate === true && !upToDate.body?.kstCodes,
      `upToDate=${upToDate.body?.upToDate}`,
    );
  }

  // 3. VIN decode (cache miss + cache hit)
  const did = randomUUID();
  const t1 = Date.now();
  const vin1 = await jsonFetch('GET', `/vin/${sampleVin}`);
  const t1ms = Date.now() - t1;
  record(
    'vin: first decode 200',
    vin1.status === 200 && Boolean(vin1.body?.make),
    `${vin1.body?.make ?? '?'} ${vin1.body?.model ?? '?'} (${t1ms}ms)`,
  );
  const t2 = Date.now();
  const vin2 = await jsonFetch('GET', `/vin/${sampleVin}`);
  const t2ms = Date.now() - t2;
  record(
    'vin: second decode served from cache',
    vin2.status === 200 && vin2.body?.cached === true,
    `${t2ms}ms cached=${vin2.body?.cached}`,
  );

  // 4. Quota init
  const quota1 = await jsonFetch('GET', '/quota', { headers: { 'X-Device-Id': did } });
  record(
    'quota: init 0/3 not pro',
    quota1.status === 200 &&
      quota1.body.freeReportsUsed === 0 &&
      quota1.body.freeReportsLimit === 3 &&
      quota1.body.isPro === false,
    JSON.stringify(quota1.body),
  );

  // 5. Three reports allowed, fourth 402
  const reservedIds = [];
  let firstS3Key, firstUploadUrl;
  for (let i = 0; i < 3; i++) {
    const r = await jsonFetch('POST', '/reports', {
      headers: { 'X-Device-Id': did },
      body: { code: `CSP-${i + 1}`, vin: sampleVin },
    });
    const ok = r.status === 201 && r.body?.reportId && r.body?.presignedUploadUrl;
    record(`reports: reservation ${i + 1}/3 (201)`, ok, `status=${r.status} tier=${r.body?.tier}`);
    if (ok) {
      reservedIds.push(r.body.reportId);
      if (i === 0) {
        firstS3Key = r.body.s3Key;
        firstUploadUrl = r.body.presignedUploadUrl;
      }
    }
  }
  const fourth = await jsonFetch('POST', '/reports', {
    headers: { 'X-Device-Id': did },
    body: { code: 'CSP-4' },
  });
  record(
    'reports: 4th reservation returns 402',
    fourth.status === 402,
    `status=${fourth.status} msg=${fourth.body?.message?.slice?.(0, 80) ?? fourth.body}`,
  );

  // 6. PDF roundtrip on the first reservation
  if (r2Up && firstUploadUrl && firstS3Key && reservedIds[0]) {
    const pdfHeader = Buffer.from('%PDF-1.4\n%verification test\n%%EOF\n');
    const synthBody = Buffer.alloc(2048, 0x20);
    const body = Buffer.concat([pdfHeader, synthBody]);
    const sha = createHash('sha256').update(body).digest('hex');

    const put = await fetch(firstUploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body,
    });
    record('r2: PUT to presigned URL', put.status >= 200 && put.status < 300, `status=${put.status}`);

    const complete = await jsonFetch('POST', `/reports/${reservedIds[0]}/complete`, {
      headers: { 'X-Device-Id': did },
    });
    record('reports: confirm complete', complete.status === 200 && complete.body?.uploaded === true, JSON.stringify(complete.body));

    const list = await jsonFetch('GET', '/reports', { headers: { 'X-Device-Id': did } });
    const item = list.body?.items?.find((it) => it.id === reservedIds[0]);
    record(
      'reports: history shows uploaded item with download URL',
      list.status === 200 && item?.uploaded === true && Boolean(item?.downloadUrl),
      `total=${list.body?.total} url=${item?.downloadUrl ? 'yes' : 'no'}`,
    );

    if (item?.downloadUrl) {
      const dl = await fetch(item.downloadUrl);
      const buf = Buffer.from(await dl.arrayBuffer());
      const dlSha = createHash('sha256').update(buf).digest('hex');
      record('r2: download presigned + SHA-256 matches', dl.status === 200 && dlSha === sha, `dl-status=${dl.status} sha-match=${dlSha === sha}`);
    }

    // 7. Delete + GDPR erase
    const del = await jsonFetch('DELETE', `/reports/${reservedIds[0]}`, {
      headers: { 'X-Device-Id': did },
    });
    record('reports: soft delete', del.status === 200 && del.body?.deleted === true, JSON.stringify(del.body));
  } else {
    record('r2: PDF roundtrip', false, 'R2 not available — skipping upload tests');
  }

  const erase = await jsonFetch('DELETE', '/me', { headers: { 'X-Device-Id': did } });
  record(
    'me: GDPR erasure',
    erase.status === 200 && erase.body?.deviceId === did,
    JSON.stringify(erase.body),
  );

  console.log('');
  console.log(`--- Summary: ${passes} passed, ${failures} failed ---`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Fatal:', err);
  process.exit(2);
});
