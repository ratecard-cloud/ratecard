import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  egressCost, effectiveMonthly, exitCost, paybackMonths, crossover,
} from '../src/lib/model.mjs';

/* Synthetic schedules with hand-computed goldens: immune to daily price drift. */
const AWSISH = {
  free_gb_per_month: 100,
  tiers: [
    { up_to_gb: 10240, usd_per_gb: 0.09 },
    { up_to_gb: 51200, usd_per_gb: 0.085 },
    { up_to_gb: null, usd_per_gb: 0.05 },
  ],
};
const FLAT = (rate, free = 0) => ({ free_gb_per_month: free, tiers: [{ up_to_gb: null, usd_per_gb: rate }] });

test('egressCost: tier arithmetic', () => {
  assert.equal(egressCost(undefined, 5000), 0, 'no schedule is free');
  assert.equal(egressCost(AWSISH, 0), 0, 'zero volume');
  assert.equal(egressCost(AWSISH, 100), 0, 'exactly the free allowance');
  assert.equal(egressCost(AWSISH, 1124), 92.16, '1024 billable, all tier 1: 1024*0.09');
  assert.equal(egressCost(AWSISH, 10340), 921.6, 'exactly fills tier 1: 10240*0.09');
  // One GB into tier 2 — the boundary where an off-by-one misprices everything after.
  assert.equal(egressCost(AWSISH, 10341), 921.69, '10240*0.09 + 1*0.085, rounded');
  // Deep into the unbounded tier.
  assert.equal(
    egressCost(AWSISH, 100 + 10240 + 40960 + 1000),
    Math.round((10240 * 0.09 + 40960 * 0.085 + 1000 * 0.05) * 100) / 100,
    'spans all three tiers',
  );
  // Tiers are measured AFTER the free allowance is consumed — the semantics the
  // whole schema documents. free=10240 + flat rate: 11 TB costs 1 TB of overage.
  assert.equal(egressCost(FLAT(0.0085, 10240), 11264), 8.7, 'OCI-like: (11264-10240)*0.0085');
});

test('effectiveMonthly: bundled allowance consumed before the paid schedule', () => {
  const row = { price_monthly_usd: 96, included_egress_gb: 5120 };
  assert.equal(effectiveMonthly(row, FLAT(0.01), 5120).total, 96, 'inside the bundle');
  assert.equal(effectiveMonthly(row, FLAT(0.01), 6144).total, 96 + 10.24, '1 TB overage at $0.01');
  const bare = { price_monthly_usd: 100, included_egress_gb: 0 };
  assert.equal(effectiveMonthly(bare, AWSISH, 1124).total, 192.16, 'base + tiered egress');
});

test('exitCost: spare bundled allowance absorbs the migration first', () => {
  const row = { price_monthly_usd: 0, included_egress_gb: 5120 };
  const sched = FLAT(0.09);
  assert.equal(exitCost(row, sched, 4096, 1024), 0, 'dataset fits in the spare 4 TB');
  assert.equal(exitCost(row, sched, 5120, 1024), 92.16, '1 TB spills over: 1024*0.09');
  assert.equal(exitCost(row, sched, 5120, 6144), 460.8, 'monthly exceeds bundle: no spare at all');
  assert.equal(exitCost(row, sched, 0, 0), 0, 'nothing to carry');
});

test('paybackMonths: null when the move never pays', () => {
  const sched = FLAT(0.09);
  const expensive = { price_monthly_usd: 200, included_egress_gb: 0 };
  const cheap = { price_monthly_usd: 100, included_egress_gb: 0 };
  assert.equal(paybackMonths(expensive, sched, cheap, sched, 1024, 0), 0.9, '92.16 toll / 100 saving');
  assert.equal(paybackMonths(cheap, sched, expensive, sched, 1024, 0), null, 'moving to dearer');
  assert.equal(paybackMonths(cheap, sched, cheap, sched, 1024, 0), null, 'zero saving');
});

test('crossover: algebraic golden', () => {
  // a: 100 + 0.10g, b: 150 + 0.05g -> equal at exactly g = 1000.
  const a = { price_monthly_usd: 100, included_egress_gb: 0 };
  const b = { price_monthly_usd: 150, included_egress_gb: 0 };
  const c = crossover(a, FLAT(0.1), b, FLAT(0.05));
  assert.ok(c, 'crossover exists');
  assert.equal(c.cheaperBelow, 'a');
  assert.equal(c.cheaperAbove, 'b');
  assert.ok(Math.abs(c.gb - 1000) <= 1, `bisection lands on ~1000, got ${c.gb}`);
});

test('crossover: null when one side dominates or they start equal', () => {
  const a = { price_monthly_usd: 100, included_egress_gb: 0 };
  const b = { price_monthly_usd: 150, included_egress_gb: 0 };
  assert.equal(crossover(a, FLAT(0.05), b, FLAT(0.05)), null, 'a cheaper at every volume');
  const eq = { price_monthly_usd: 100, included_egress_gb: 0 };
  assert.equal(crossover(a, FLAT(0.1), eq, FLAT(0.05)), null, 'equal at zero: no verdict');
});

/* Invariants over the real committed dataset — phrased so daily price drift
 * cannot break them, only a genuine model bug can. */
test('real dataset: model invariants hold for every provider pair', async () => {
  const compute = JSON.parse(await readFile('data/normalized/compute.json', 'utf8'));
  const egress = JSON.parse(await readFile('data/normalized/egress.json', 'utf8'));
  const sched = (p, r) => egress.find((e) => e.provider === p && e.region === r);
  const pick = (p) =>
    compute
      .filter((r) => r.provider === p && r.region === 'us-east' && r.vcpu === 4 && r.ram_gb === 16)
      .sort((x, y) => x.price_monthly_usd - y.price_monthly_usd)[0];

  const providers = [...new Set(compute.map((r) => r.provider))];
  let pairs = 0;
  for (let i = 0; i < providers.length; i++) {
    for (let j = i + 1; j < providers.length; j++) {
      const ra = pick(providers[i]);
      const rb = pick(providers[j]);
      if (!ra || !rb) continue;
      pairs++;
      const sa = sched(ra.provider, 'us-east');
      const sb = sched(rb.provider, 'us-east');
      const c = crossover(ra, sa, rb, sb);
      if (!c) continue;
      // Self-consistency: the winner really does change hands across c.gb.
      const below =
        effectiveMonthly(ra, sa, Math.max(0, c.gb - 2)).total -
        effectiveMonthly(rb, sb, Math.max(0, c.gb - 2)).total;
      const above =
        effectiveMonthly(ra, sa, c.gb + 2).total - effectiveMonthly(rb, sb, c.gb + 2).total;
      assert.ok(below * above <= 0, `${ra.provider} vs ${rb.provider}: sign must flip across ${c.gb} GB`);
    }
  }
  assert.ok(pairs >= 15, `expected a real pair matrix, got ${pairs}`);

  // Monotonicity: more egress never makes any row cheaper.
  for (const r of compute.filter((x) => x.region === 'us-east')) {
    const s = sched(r.provider, r.region);
    let prev = -Infinity;
    for (const gb of [0, 100, 1024, 10240, 102400]) {
      const t = effectiveMonthly(r, s, gb).total;
      assert.ok(t >= prev, `${r.provider}/${r.sku}: total decreased at ${gb} GB`);
      prev = t;
    }
  }
});
