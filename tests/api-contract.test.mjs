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
  assert.deepEqual(resources, ['changes', 'compute', 'egress', 'history', 'ipv4', 'providers', 'regions', 'storage']);
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

const V1_HISTORY_RECORD = ['provider', 'region', 'sku', 'first_seen', 'last_seen', 'segments'];
const V1_CHANGE_EVENT = ['date', 'type', 'provider', 'region'];

test('api v1: history contract holds', { skip: !built }, async () => {
  const body = JSON.parse(await readFile('dist/api/v1/history.json', 'utf8'));
  for (const k of V1_ENVELOPE) assert.ok(k in body, `envelope lost "${k}"`);
  assert.equal(body.count, body.records.length);
  for (const k of V1_HISTORY_RECORD) {
    assert.ok(k in body.records[0], `history record lost "${k}" — v1 must not remove fields`);
  }
  for (const r of body.records) {
    assert.ok(r.segments.length >= 1, `${r.sku}: at least one segment`);
    for (let i = 1; i < r.segments.length; i++) {
      assert.ok(r.segments[i].since > r.segments[i - 1].since, `${r.sku}: segments ascend by date`);
      assert.ok(
        r.segments[i].monthly !== r.segments[i - 1].monthly ||
          r.segments[i].hourly !== r.segments[i - 1].hourly,
        `${r.sku}: consecutive segments must differ — run-length means no flat splits`,
      );
    }
  }
});

test('api v1: changes contract holds and is newest-first', { skip: !built }, async () => {
  const body = JSON.parse(await readFile('dist/api/v1/changes.json', 'utf8'));
  for (const k of V1_ENVELOPE) assert.ok(k in body, `envelope lost "${k}"`);
  assert.equal(body.count, body.records.length);
  for (const k of V1_CHANGE_EVENT) {
    assert.ok(k in body.records[0], `change event lost "${k}"`);
  }
  for (let i = 1; i < body.records.length; i++) {
    assert.ok(body.records[i - 1].date >= body.records[i].date, 'newest first');
  }
});

const V1_STORAGE_RECORD = [
  'provider', 'region', 'sku', 'display_name', 'kind', 'usd_per_gb_month',
  'min_size_gb', 'max_size_gb', 'baseline_iops', 'baseline_throughput_mbps',
  'currency', 'source_url', 'collected_at', 'source_verified_at', 'confidence', 'notes',
];

test('api v1: storage contract holds', { skip: !built }, async () => {
  const body = JSON.parse(await readFile('dist/api/v1/storage.json', 'utf8'));
  for (const k of V1_ENVELOPE) assert.ok(k in body, `envelope lost "${k}"`);
  assert.equal(body.count, body.records.length);
  for (const k of V1_STORAGE_RECORD) {
    assert.ok(k in body.records[0], `storage record lost "${k}" — v1 must not remove fields`);
  }
  for (const r of body.records) {
    assert.equal(r.kind, 'block');
    assert.ok(r.usd_per_gb_month > 0.005 && r.usd_per_gb_month < 0.5,
      `${r.provider}/${r.sku}: $${r.usd_per_gb_month}/GB-month outside sanity band`);
  }
});

test('api v1: ipv4 contract holds', { skip: !built }, async () => {
  const body = JSON.parse(await readFile('dist/api/v1/ipv4.json', 'utf8'));
  for (const k of V1_ENVELOPE) assert.ok(k in body, `envelope lost "${k}"`);
  assert.equal(body.count, body.records.length);
  const FIELDS = ['provider', 'region', 'sku', 'usd_per_month', 'usd_per_hour',
    'included_with_instance', 'source_url', 'confidence', 'notes'];
  for (const k of FIELDS) assert.ok(k in body.records[0], `ipv4 record lost "${k}"`);
  for (const r of body.records) {
    assert.ok(r.usd_per_month >= 0 && r.usd_per_month <= 10, `${r.provider}: $${r.usd_per_month}/mo out of band`);
    if (r.usd_per_month === 0) {
      assert.ok(r.notes.length > 0, `${r.provider}: a $0 claim must cite its evidence`);
    }
  }
});
