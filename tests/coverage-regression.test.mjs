/**
 * The fail-closed coverage check, pinned by the incident that shaped it: on
 * its first CI run it caught DigitalOcean's fra1 shedding 24 of 63 qualifying
 * sizes in seven hours. That was capacity churn, not breakage — DO's
 * sizes.regions reflects live capacity — hence the per-provider tolerance.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validatePreviousCoverage } from '../pipeline/validate.mjs';

const compute = JSON.parse(await readFile('data/normalized/compute.json', 'utf8'));
const egress = JSON.parse(await readFile('data/normalized/egress.json', 'utf8'));

/** Keep only the first `keep` records of one provider/region. */
function shrink(records, provider, region, keep) {
  let n = 0;
  return records.filter((r) => r.provider !== provider || r.region !== region || n++ < keep);
}
const count = (p, reg) => compute.filter((r) => r.provider === p && r.region === reg).length;
const errsFor = (r, needle) => r.errors.filter((e) => e.includes(needle));
// Hermetic: no rolling coverage record, so only the previous-run comparison
// applies. Threshold tests would otherwise depend on whatever flap states the
// real data/history/coverage.json happens to hold.
const NO_BASELINES = { baselines: {} };
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

test('unchanged coverage is silent', async () => {
  const r = await validatePreviousCoverage(compute, egress);
  assert.deepEqual(r.errors, []);
});

test('DigitalOcean capacity churn passes under its widened tolerance', async () => {
  // The real incident was 63 -> 39 (-38%). Counts must be RATIOS of whatever
  // the workspace dataset currently holds: in CI, `npm run data` rewrites the
  // baseline before tests run, so absolute counts go stale within one run —
  // which is exactly how the first version of this test failed in CI.
  const keep = Math.round(count('digitalocean', 'eu-central') * 0.62); // ~38% drop
  const r = await validatePreviousCoverage(shrink(compute, 'digitalocean', 'eu-central', keep), egress);
  assert.deepEqual(errsFor(r, 'digitalocean'), [], '38% is inside DO tolerance (0.5)');
  assert.ok(r.warnings.some((w) => w.includes('digitalocean/eu-central')), 'still warned');
});

test('the same drop percentage stays fatal for a strict provider', async () => {
  const keep = Math.round(count('aws', 'us-east') * 0.62); // ~38% drop
  const r = await validatePreviousCoverage(shrink(compute, 'aws', 'us-east', keep), egress, {}, {}, NO_BASELINES);
  assert.ok(errsFor(r, 'aws/us-east').length > 0, 'AWS has no tolerance override');
});

test('tolerance widens the threshold, it does not remove it', async () => {
  const keep = Math.round(count('digitalocean', 'eu-central') * 0.4); // ~60% drop
  const r = await validatePreviousCoverage(shrink(compute, 'digitalocean', 'eu-central', keep), egress, {}, {}, NO_BASELINES);
  assert.ok(errsFor(r, 'digitalocean').length > 0, '-60% exceeds even 0.5');
});

test('vanishing to zero is fatal regardless of tolerance', async () => {
  const r = await validatePreviousCoverage(shrink(compute, 'digitalocean', 'eu-central', 0), egress);
  const errs = errsFor(r, 'digitalocean/eu-central');
  assert.ok(errs.length > 0);
  assert.match(errs[0], /ZERO/, 'zero has its own unambiguous message');
});

test('ALLOW_COVERAGE_DROP downgrades errors to warnings for that provider only', async () => {
  process.env.ALLOW_COVERAGE_DROP = 'digitalocean';
  try {
    const gone = await validatePreviousCoverage(shrink(compute, 'digitalocean', 'eu-central', 0), egress);
    assert.deepEqual(errsFor(gone, 'digitalocean'), [], 'override permits the removal');
    const aws = await validatePreviousCoverage(shrink(compute, 'aws', 'us-east', 0), egress);
    assert.ok(errsFor(aws, 'aws').length > 0, 'override is scoped, not global');
  } finally {
    delete process.env.ALLOW_COVERAGE_DROP;
  }
});

test('a drop matching a recently published state passes as a flap', async () => {
  // The incident that shaped this: fra1 flapped 39 -> 18 -> 39 -> 18 across
  // four days; 18 had been reviewed and accepted, yet each down-day re-failed.
  const keep = Math.round(count('digitalocean', 'eu-central') * 0.4); // over even 0.5
  const baselines = {
    'compute digitalocean/eu-central': [{ date: daysAgo(3), count: keep }],
  };
  const r = await validatePreviousCoverage(
    shrink(compute, 'digitalocean', 'eu-central', keep), egress, {}, {}, { baselines });
  assert.deepEqual(errsFor(r, 'digitalocean'), [], 'known state is not a regression');
  assert.ok(r.warnings.some((w) => w.includes('flap')), 'still warned, and named as a flap');
});

test('the window does not admit a drop below every recorded state', async () => {
  const keep = Math.round(count('digitalocean', 'eu-central') * 0.4);
  const baselines = {
    // recorded low is well above where we land now (0.9 slack included)
    'compute digitalocean/eu-central': [{ date: daysAgo(3), count: keep * 2 }],
  };
  const r = await validatePreviousCoverage(
    shrink(compute, 'digitalocean', 'eu-central', keep), egress, {}, {}, { baselines });
  assert.ok(errsFor(r, 'digitalocean').length > 0, 'unfamiliar collapse still fails closed');
});

test('a recorded state outside the 14-day window has expired', async () => {
  const keep = Math.round(count('digitalocean', 'eu-central') * 0.4);
  const baselines = {
    'compute digitalocean/eu-central': [{ date: daysAgo(20), count: keep }],
  };
  const r = await validatePreviousCoverage(
    shrink(compute, 'digitalocean', 'eu-central', keep), egress, {}, {}, { baselines });
  assert.ok(errsFor(r, 'digitalocean').length > 0, 'stale acceptance does not linger');
});

test('the window never rescues a vanish to zero', async () => {
  const baselines = {
    'compute digitalocean/eu-central': [{ date: daysAgo(3), count: 0 }],
  };
  const r = await validatePreviousCoverage(
    shrink(compute, 'digitalocean', 'eu-central', 0), egress, {}, {}, { baselines });
  assert.match(errsFor(r, 'digitalocean/eu-central')[0], /ZERO/);
});
