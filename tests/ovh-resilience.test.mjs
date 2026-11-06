/**
 * OVH reads two independent catalogs (US and international). The 2026-11-06
 * incident: the US catalog 500'd, egress reused the cached failure, and all
 * four OVH egress regions vanished — including DE1 and SGP1, whose catalog was
 * up. These pin both halves of the fix against the committed egress fixture.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.RC_NO_WRITE = '1';

let usDown = true;
let usFetches = 0;
let ovhSchedules;
let catalog;

before(async () => {
  const raw = JSON.parse(await readFile('data/raw/ovh/egress.json', 'utf8'));
  const catalogs = {
    US: { locale: { currencyCode: 'USD' }, addons: [raw['us-east']] },
    WE: { locale: { currencyCode: 'USD' }, addons: [raw['eu-central'], raw['ap-southeast']] },
  };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.us.ovhcloud.com')) {
      usFetches++;
      // 404, not 500: a non-retryable status fails at once instead of
      // sitting through getJSON's backoff.
      if (usDown) return { ok: false, status: 404, statusText: 'Not Found', headers: new Headers() };
      return { ok: true, status: 200, json: async () => catalogs.US };
    }
    if (u.includes('ovhSubsidiary=WE')) return { ok: true, status: 200, json: async () => catalogs.WE };
    throw new Error(`unstubbed fetch in ovh resilience test: ${u}`);
  };
  ({ ovhSchedules } = await import('../pipeline/collectors/egress.mjs'));
  ({ catalog } = await import('../pipeline/collectors/ovh.mjs'));
});

test('a US catalog failure costs only the US egress regions', async () => {
  const sched = await ovhSchedules();
  assert.deepEqual(Object.keys(sched).sort(), ['ap-southeast', 'eu-central']);
  assert.equal(sched['ap-southeast'].free_gb_per_month, 1024, 'SGP1 still priced from the WE catalog');
});

test('a failed catalog fetch is not cached: the next caller tries again', async () => {
  const before = usFetches;
  usDown = false;
  const cat = await catalog('US');
  assert.equal(usFetches, before + 1, 'refetched rather than replaying the rejection');
  assert.equal(cat.addons.length, 1);
  const sched = await ovhSchedules();
  assert.deepEqual(Object.keys(sched).sort(), ['ap-southeast', 'eu-central', 'us-east', 'us-west']);
});
