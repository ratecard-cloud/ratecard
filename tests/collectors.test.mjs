/**
 * Collector fixture tests: replay each collector against the committed raw
 * payload (data/raw/<provider>/) and require its output to equal the committed
 * normalized records for that provider, timestamps aside.
 *
 * Raw and normalized are written by the same pipeline run, so they are always
 * mutually consistent — the daily refresh updates the fixtures and the
 * expectations together. What this pins is the TRANSFORM: the Hetzner
 * per-location included_traffic bug and Linode's null-monthly g8 handling were
 * both transform bugs that shipped; either would fail here today.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.RC_NO_WRITE = '1';
process.env.HETZNER_API_TOKEN = 'fixture-run-no-network';

const raw = async (p) => JSON.parse(await readFile(`data/raw/${p}/compute.json`, 'utf8'));

let fixtures;
before(async () => {
  fixtures = {
    vultr: await raw('vultr'),
    linode: await raw('linode'),
    hetzner: await raw('hetzner'),
  };
  // Route by URL; anything unrouted is a test bug, not a network call.
  globalThis.fetch = async (url) => {
    const u = String(url);
    let payload;
    if (u.includes('api.vultr.com/v2/plans')) payload = fixtures.vultr;
    else if (u.includes('api.linode.com/v4/linode/types')) payload = fixtures.linode;
    else if (u.includes('api.hetzner.cloud/v1/server_types')) payload = fixtures.hetzner.server_types;
    else if (u.includes('api.hetzner.cloud/v1/pricing')) payload = fixtures.hetzner.pricing;
    else throw new Error(`unstubbed fetch in collector test: ${u}`);
    return { ok: true, status: 200, statusText: 'OK', json: async () => payload };
  };
});

const strip = ({ collected_at, ...rest }) => rest;
const byKey = (a, b) =>
  a.provider.localeCompare(b.provider) || a.region.localeCompare(b.region) ||
  String(a.sku).localeCompare(String(b.sku));

async function expectMatchesCommitted(providerKey, collectorPath) {
  const { default: collect } = await import(collectorPath);
  const got = (await collect()).map(strip).sort(byKey);
  const committed = JSON.parse(await readFile('data/normalized/compute.json', 'utf8'))
    .filter((r) => r.provider === providerKey)
    .map(strip)
    .sort(byKey);
  assert.ok(committed.length > 0, `no committed ${providerKey} records to compare against`);
  assert.deepEqual(got, committed, `${providerKey}: transform output diverged from committed normalized data`);
  return got;
}

test('vultr: fixture replay reproduces committed records', async () => {
  const got = await expectMatchesCommitted('vultr', '../pipeline/collectors/vultr.mjs');
  assert.ok(got.every((r) => ['shared', 'dedicated'].includes(r.vcpu_type)));
});

test('linode: fixture replay reproduces committed records (incl. g8 null-monthly)', async () => {
  const got = await expectMatchesCommitted('linode', '../pipeline/collectors/linode.mjs');
  // The two billing quirks the validator once caught must stay explained.
  const g8 = got.filter((r) => r.sku.startsWith('g8-'));
  assert.ok(g8.length > 0, 'g8 generation present');
  assert.ok(
    g8.every((r) => Math.abs(r.price_hourly_usd * 730 - r.price_monthly_usd) < 0.01),
    'g8 monthly must be derived as hourly*730 (Linode quotes monthly: null)',
  );
});

test('hetzner: fixture replay reproduces committed records (incl. per-location traffic)', async () => {
  const got = await expectMatchesCommitted('hetzner', '../pipeline/collectors/hetzner.mjs');
  // The bug that shipped: included_traffic read off the wrong object -> all zeros.
  assert.ok(got.every((r) => r.included_egress_gb > 0), 'every Hetzner row bundles traffic');
  const eu = got.filter((r) => r.region === 'eu-central').map((r) => r.included_egress_gb);
  const us = got.filter((r) => r.region === 'us-east').map((r) => r.included_egress_gb);
  assert.ok(Math.min(...eu) >= 20480, 'EU bundles at least 20 TiB');
  assert.ok(Math.max(...us) < 20480, 'US bundles far less than EU — must not be assumed uniform');
});
