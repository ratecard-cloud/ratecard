/**
 * API v1 contract: the /api docs promise that within a version fields are
 * added, never removed or repurposed. These frozen field lists ARE that
 * promise — deleting a field from the API breaks this test before it breaks
 * a consumer. Extra fields are always allowed.
 *
 * Runs against dist/, so it needs a build; skips cleanly when there is none
 * (CI builds before testing, so it is always enforced there).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const V1_ENVELOPE = [
  'resource', 'version', 'generated_at', 'count', 'license', 'license_url',
  'attribution', 'documentation', 'source', 'disclaimer', 'records',
];
const V1_COMPUTE_RECORD = [
  'provider', 'region', 'region_code', 'sku', 'display_name', 'vcpu',
  'vcpu_type', 'vcpu_unit', 'ram_gb', 'arch', 'local_storage_gb',
  'included_egress_gb', 'price_hourly_usd', 'price_monthly_usd', 'currency',
  'source_url', 'collected_at', 'source_verified_at', 'confidence', 'notes',
];
const V1_EGRESS_RECORD = [
  'provider', 'region', 'free_gb_per_month', 'bundled_with_compute', 'tiers',
  'currency', 'source_url', 'collected_at', 'source_verified_at', 'confidence', 'notes',
];

const built = existsSync('dist/api/v1/index.json');

test('api v1: discovery document lists every endpoint', { skip: !built }, async () => {
  const idx = JSON.parse(await readFile('dist/api/v1/index.json', 'utf8'));
  assert.equal(idx.version, 'v1');
  const resources = idx.endpoints.map((e) => e.resource).sort();
  assert.deepEqual(resources, ['compute', 'egress', 'providers', 'regions']);
  for (const e of idx.endpoints) {
    const path = 'dist' + new URL(e.url).pathname;
    assert.ok(existsSync(path), `${e.url} advertised but ${path} not built`);
  }
});

test('api v1: compute contract holds', { skip: !built }, async () => {
  const body = JSON.parse(await readFile('dist/api/v1/compute.json', 'utf8'));
  for (const k of V1_ENVELOPE) assert.ok(k in body, `envelope lost "${k}"`);
  assert.equal(body.count, body.records.length, 'count must equal records.length');
  assert.ok(body.records.length > 0);
  for (const k of V1_COMPUTE_RECORD) {
    assert.ok(k in body.records[0], `compute record lost "${k}" — v1 must not remove fields`);
  }
  // Spot the semantics the docs call out, on every record.
  for (const r of body.records) {
    assert.ok(['shared', 'dedicated'].includes(r.vcpu_type), `${r.sku}: vcpu_type`);
    assert.ok(['thread', 'core'].includes(r.vcpu_unit), `${r.sku}: vcpu_unit`);
    assert.ok(r.price_monthly_usd > 0, `${r.sku}: price`);
  }
});

test('api v1: egress contract holds', { skip: !built }, async () => {
  const body = JSON.parse(await readFile('dist/api/v1/egress.json', 'utf8'));
  for (const k of V1_ENVELOPE) assert.ok(k in body, `envelope lost "${k}"`);
  assert.equal(body.count, body.records.length);
  for (const k of V1_EGRESS_RECORD) {
    assert.ok(k in body.records[0], `egress record lost "${k}" — v1 must not remove fields`);
  }
  for (const r of body.records) {
    assert.equal(r.tiers.at(-1).up_to_gb, null, `${r.provider}/${r.region}: final tier must be unbounded`);
  }
});

test('api v1: providers endpoint never leaks affiliate URLs', { skip: !built }, async () => {
  const body = JSON.parse(await readFile('dist/api/v1/providers.json', 'utf8'));
  for (const r of body.records) {
    assert.ok(!('affiliate' in r), `${r.key}: affiliate must stay out of the public data`);
  }
});
