/**
 * The history materializer, pinned before anything consumes it. The property
 * that matters most: a same-day rerun must never double-report — the first
 * CI day ran twice (05:49 and 12:39) with different DigitalOcean coverage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotOf, diffSnapshots, step, emptyHistory,
} from '../pipeline/history-lib.mjs';

const row = (sku, monthly, opts = {}) => ({
  provider: 'p', region: 'r', sku,
  price_monthly_usd: monthly, price_hourly_usd: monthly / 730,
  included_egress_gb: opts.inc ?? 0,
});
const sched = (rate) => ({
  provider: 'p', region: 'r', free_gb_per_month: 0, bundled_with_compute: false,
  tiers: [{ up_to_gb: null, usd_per_gb: rate }],
});

test('diff: added, removed, price and allowance changes', () => {
  const prev = snapshotOf([row('a', 100), row('b', 50, { inc: 1024 })], [sched(0.09)]);
  const next = snapshotOf([row('a', 110), row('b', 50, { inc: 2048 }), row('c', 30)], [sched(0.05)]);
  const ev = diffSnapshots(prev, next, '2026-01-02');
  const types = ev.map((e) => e.type).sort();
  assert.deepEqual(types, ['allowance_changed', 'egress_changed', 'price_changed', 'sku_added']);
  const price = ev.find((e) => e.type === 'price_changed');
  assert.equal(price.monthly_old, 100);
  assert.equal(price.monthly_new, 110);
});

test('series: run-length — flat prices produce one segment across many days', () => {
  let h = emptyHistory();
  for (const d of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']) {
    h = step(h, [row('a', 100)], [sched(0.09)], d);
  }
  const s = h.series['p/r/a'];
  assert.equal(s.segments.length, 1, 'no price change, one segment');
  assert.equal(s.first_seen, '2026-01-01');
  assert.equal(s.last_seen, '2026-01-04');
  assert.equal(h.changes.length, 0, 'first day seeds silently; flat days emit nothing');
});

test('series: a price change opens a new segment; removal and return are dated', () => {
  let h = emptyHistory();
  h = step(h, [row('a', 100)], [sched(0.09)], '2026-01-01');
  h = step(h, [row('a', 120)], [sched(0.09)], '2026-01-02');
  h = step(h, [], [sched(0.09)], '2026-01-03');
  h = step(h, [row('a', 120)], [sched(0.09)], '2026-01-04');

  const s = h.series['p/r/a'];
  assert.deepEqual(s.segments.map((x) => [x.since, x.monthly]), [['2026-01-01', 100], ['2026-01-02', 120]]);
  assert.equal(s.removed, undefined, 'return clears the removal marker');
  const types = h.changes.map((e) => `${e.date}:${e.type}`);
  assert.deepEqual(types, ['2026-01-02:price_changed', '2026-01-03:sku_removed', '2026-01-04:sku_added']);
});

test('same-day rerun replaces the day, never double-reports', () => {
  let h = emptyHistory();
  h = step(h, [row('a', 100), row('b', 50)], [sched(0.09)], '2026-01-01');
  // Morning run: b vanished.
  h = step(h, [row('a', 100)], [sched(0.09)], '2026-01-02');
  assert.equal(h.changes.filter((e) => e.date === '2026-01-02').length, 1);
  // Midday rerun: b is back — the day's events must be recomputed against
  // YESTERDAY, so the net result is "nothing happened on the 2nd".
  h = step(h, [row('a', 100), row('b', 50)], [sched(0.09)], '2026-01-02');
  assert.deepEqual(h.changes.filter((e) => e.date === '2026-01-02'), [], 'flap collapsed to no event');
  assert.equal(h.series['p/r/b'].removed, undefined);
  // And a same-day price correction rewrites today's segment in place.
  h = step(h, [row('a', 105), row('b', 50)], [sched(0.09)], '2026-01-02');
  const a = h.series['p/r/a'];
  assert.deepEqual(a.segments.map((x) => [x.since, x.monthly]), [['2026-01-01', 100], ['2026-01-02', 105]]);
  h = step(h, [row('a', 105), row('b', 50)], [sched(0.09)], '2026-01-03');
  assert.equal(a === h.series['p/r/a'], false, 'immutable update');
  assert.equal(h.series['p/r/a'].segments.length, 2, 'no third segment on the flat day after');
});

test('next-day diffing uses the final same-day state, not the morning run', () => {
  let h = emptyHistory();
  h = step(h, [row('a', 100)], [sched(0.09)], '2026-01-01');
  h = step(h, [row('a', 100)], [sched(0.09)], '2026-01-02'); // morning
  h = step(h, [row('a', 110)], [sched(0.09)], '2026-01-02'); // midday correction
  h = step(h, [row('a', 110)], [sched(0.09)], '2026-01-03'); // next day, unchanged
  assert.deepEqual(h.changes.filter((e) => e.date === '2026-01-03'), [], 'no phantom change on day 3');
});
