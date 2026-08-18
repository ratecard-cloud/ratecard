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

test('unchanged coverage is silent', async () => {
  const r = await validatePreviousCoverage(compute, egress);
  assert.deepEqual(r.errors, []);
});

test('DigitalOcean capacity churn passes under its widened tolerance', async () => {
  // The real incident: 63 -> 39 in eu-central, a 38% drop.
  const r = await validatePreviousCoverage(shrink(compute, 'digitalocean', 'eu-central', 39), egress);
  assert.deepEqual(errsFor(r, 'digitalocean'), [], '38% is inside DO tolerance (0.5)');
  assert.ok(r.warnings.some((w) => w.includes('digitalocean/eu-central')), 'still warned');
});

test('the same drop percentage stays fatal for a strict provider', async () => {
  const keep = Math.round(count('aws', 'us-east') * 0.62); // ~38% drop
  const r = await validatePreviousCoverage(shrink(compute, 'aws', 'us-east', keep), egress);
  assert.ok(errsFor(r, 'aws/us-east').length > 0, 'AWS has no tolerance override');
});

test('tolerance widens the threshold, it does not remove it', async () => {
  const r = await validatePreviousCoverage(shrink(compute, 'digitalocean', 'eu-central', 25), egress);
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
