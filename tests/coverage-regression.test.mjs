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

/**
 * Threshold tests run on a fixed synthetic dataset: 100 records per region, so
 * "keep 20" is exactly -80%. They used to take fractions of the live DO count,
 * which CI rewrites just before tests run — on 2026-11-26 DO fra1 listed 3
 * sizes, 20% of 3 rounded to 1, the "-80%" case became -67% (inside the 0.7
 * tolerance) and four tests failed on a perfectly healthy run.
 */
const PER_REGION = 100;
const synthetic = (provider, region) =>
  Array.from({ length: PER_REGION }, (_, i) => ({ provider, region, sku: `${provider}-${i}` }));
const compute = [...synthetic('digitalocean', 'eu-central'), ...synthetic('aws', 'us-east')];
const egress = [
  { provider: 'digitalocean', region: 'eu-central' },
  { provider: 'aws', region: 'us-east' },
];
const PREVIOUS = { compute, egress };

/** Keep only the first `keep` records of one provider/region. */
function shrink(records, provider, region, keep) {
  let n = 0;
  return records.filter((r) => r.provider !== provider || r.region !== region || n++ < keep);
}
const errsFor = (r, needle) => r.errors.filter((e) => e.includes(needle));
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/**
 * Validate `current` against the synthetic baseline. Hermetic by default: no
 * rolling coverage record, so only the previous-run comparison applies unless
 * a test passes its own `baselines`.
 */
const check = (current, opts = {}) =>
  validatePreviousCoverage(current, egress, {}, {}, { previous: PREVIOUS, baselines: {}, ...opts });

test('unchanged coverage is silent', async () => {
  // The one test on the real committed datasets: today's data against itself.
  const real = JSON.parse(await readFile('data/normalized/compute.json', 'utf8'));
  const realEgress = JSON.parse(await readFile('data/normalized/egress.json', 'utf8'));
  const r = await validatePreviousCoverage(real, realEgress);
  assert.deepEqual(r.errors, []);
});

test('DigitalOcean capacity churn passes under its widened tolerance', async () => {
  // The real incident was 63 -> 39 (-38%).
  const keep = 62; // ~38% drop
  const r = await check(shrink(compute, 'digitalocean', 'eu-central', keep));
  assert.deepEqual(errsFor(r, 'digitalocean'), [], '38% is inside DO tolerance (0.7)');
  assert.ok(r.warnings.some((w) => w.includes('digitalocean/eu-central')), 'still warned');
});

test('the same drop percentage stays fatal for a strict provider', async () => {
  const keep = 62; // ~38% drop
  const r = await check(shrink(compute, 'aws', 'us-east', keep));
  assert.ok(errsFor(r, 'aws/us-east').length > 0, 'AWS has no tolerance override');
});

test('DigitalOcean Basic-only state (-57%) passes under its tolerance', async () => {
  // 2026-10-21: nyc1 went 42 -> 18 (every dedicated shape gone) and blocked
  // the whole refresh at 0.5. All four DO regions have now done this.
  const keep = 43; // ~57% drop
  const r = await check(shrink(compute, 'digitalocean', 'eu-central', keep));
  assert.deepEqual(errsFor(r, 'digitalocean'), [], '57% is inside DO tolerance (0.7)');
});

test('tolerance widens the threshold, it does not remove it', async () => {
  const keep = 20; // ~80% drop
  const r = await check(shrink(compute, 'digitalocean', 'eu-central', keep));
  assert.ok(errsFor(r, 'digitalocean').length > 0, '-80% exceeds even 0.7');
});

test('vanishing to zero is fatal regardless of tolerance', async () => {
  const r = await check(shrink(compute, 'digitalocean', 'eu-central', 0));
  const errs = errsFor(r, 'digitalocean/eu-central');
  assert.ok(errs.length > 0);
  assert.match(errs[0], /ZERO/, 'zero has its own unambiguous message');
});

test('ALLOW_COVERAGE_DROP downgrades errors to warnings for that provider only', async () => {
  process.env.ALLOW_COVERAGE_DROP = 'digitalocean';
  try {
    const gone = await check(shrink(compute, 'digitalocean', 'eu-central', 0));
    assert.deepEqual(errsFor(gone, 'digitalocean'), [], 'override permits the removal');
    const aws = await check(shrink(compute, 'aws', 'us-east', 0));
    assert.ok(errsFor(aws, 'aws').length > 0, 'override is scoped, not global');
  } finally {
    delete process.env.ALLOW_COVERAGE_DROP;
  }
});

test('a drop matching a recently published state passes as a flap', async () => {
  // The incident that shaped this: fra1 flapped 39 -> 18 -> 39 -> 18 across
  // four days; 18 had been reviewed and accepted, yet each down-day re-failed.
  const keep = 20; // over even 0.7
  const baselines = {
    'compute digitalocean/eu-central': [{ date: daysAgo(3), count: keep }],
  };
  const r = await check(shrink(compute, 'digitalocean', 'eu-central', keep), { baselines });
  assert.deepEqual(errsFor(r, 'digitalocean'), [], 'known state is not a regression');
  assert.ok(r.warnings.some((w) => w.includes('flap')), 'still warned, and named as a flap');
});

test('the window does not admit a drop below every recorded state', async () => {
  const keep = 20; // over even 0.7
  const baselines = {
    // recorded low is well above where we land now (0.9 slack included)
    'compute digitalocean/eu-central': [{ date: daysAgo(3), count: keep * 2 }],
  };
  const r = await check(shrink(compute, 'digitalocean', 'eu-central', keep), { baselines });
  assert.ok(errsFor(r, 'digitalocean').length > 0, 'unfamiliar collapse still fails closed');
});

test('a recorded state outside the 14-day window has expired', async () => {
  const keep = 20; // over even 0.7
  const baselines = {
    'compute digitalocean/eu-central': [{ date: daysAgo(20), count: keep }],
  };
  const r = await check(shrink(compute, 'digitalocean', 'eu-central', keep), { baselines });
  assert.ok(errsFor(r, 'digitalocean').length > 0, 'stale acceptance does not linger');
});

test('the window never rescues a vanish to zero', async () => {
  const baselines = {
    'compute digitalocean/eu-central': [{ date: daysAgo(3), count: 0 }],
  };
  const r = await check(shrink(compute, 'digitalocean', 'eu-central', 0), { baselines });
  assert.match(errsFor(r, 'digitalocean/eu-central')[0], /ZERO/);
});
