/**
 * The pricing model, free of any dataset.
 *
 * Everything here is a pure function of its arguments: no JSON imports, no
 * lookups, no globals. That is what lets `node --test` exercise the same code
 * the site ships — data.ts binds these to the dataset and re-exports them with
 * the original signatures, so pages never see the difference.
 *
 * The arithmetic (including rounding) is verbatim from data.ts; tests pin it.
 *
 * @typedef {{ up_to_gb: number | null, usd_per_gb: number }} EgressTier
 * @typedef {{ free_gb_per_month?: number | null, tiers: EgressTier[] }} EgressSchedule
 * @typedef {{ price_monthly_usd: number, included_egress_gb?: number | null }} PricedRow
 */

/**
 * Cost of `gb` outbound under a tiered schedule, after the free allowance.
 * Tiers are cumulative and measured AFTER free_gb_per_month is consumed;
 * a null up_to_gb marks the unbounded final tier.
 *
 * @param {EgressSchedule | undefined} sched
 * @param {number} gb
 * @returns {number}
 */
export function egressCost(sched, gb) {
  if (!sched) return 0;
  let remaining = Math.max(0, gb - (sched.free_gb_per_month ?? 0));
  let cost = 0;
  let floor = 0;
  for (const tier of sched.tiers) {
    if (remaining <= 0) break;
    const span = tier.up_to_gb == null ? Infinity : tier.up_to_gb - floor;
    const used = Math.min(remaining, span);
    cost += used * tier.usd_per_gb;
    remaining -= used;
    floor = tier.up_to_gb ?? floor;
  }
  return Math.round(cost * 100) / 100;
}

/**
 * The site's headline number. Bundled per-plan allowance is consumed first,
 * then the provider's account-level free tier, then the paid tiers.
 *
 * @param {PricedRow} row
 * @param {EgressSchedule | undefined} sched
 * @param {number} egressGb
 */
export function effectiveMonthly(row, sched, egressGb) {
  const billable = Math.max(0, egressGb - (row.included_egress_gb ?? 0));
  const egressUsd = egressCost(sched, billable);
  return {
    base: row.price_monthly_usd,
    egress: egressUsd,
    total: Math.round((row.price_monthly_usd + egressUsd) * 100) / 100,
  };
}

/**
 * One-off cost to move `datasetGb` out of a provider — the toll on leaving.
 * The bundled allowance is monthly and ordinary traffic consumes it first,
 * so only the spare capacity absorbs the migration.
 *
 * @param {PricedRow} row
 * @param {EgressSchedule | undefined} sched
 * @param {number} datasetGb
 * @param {number} [monthlyEgressGb]
 */
export function exitCost(row, sched, datasetGb, monthlyEgressGb = 0) {
  const spare = Math.max(0, (row.included_egress_gb ?? 0) - monthlyEgressGb);
  const billable = Math.max(0, datasetGb - spare);
  return egressCost(sched, billable);
}

/**
 * Months until a migration pays for itself; null when the move never pays.
 *
 * @param {PricedRow} from
 * @param {EgressSchedule | undefined} fromSched
 * @param {PricedRow} to
 * @param {EgressSchedule | undefined} toSched
 * @param {number} datasetGb
 * @param {number} monthlyEgressGb
 */
export function paybackMonths(from, fromSched, to, toSched, datasetGb, monthlyEgressGb) {
  const saving =
    effectiveMonthly(from, fromSched, monthlyEgressGb).total -
    effectiveMonthly(to, toSched, monthlyEgressGb).total;
  if (saving <= 0) return null;
  const toll = exitCost(from, fromSched, datasetGb, monthlyEgressGb);
  return Math.round((toll / saving) * 10) / 10;
}

/**
 * The egress volume at which the cheaper of two options changes hands, or
 * null if one is cheaper at every volume. Returns which side wins below the
 * crossing ('a' | 'b'); the caller maps that back to its own objects.
 *
 * @param {PricedRow} a
 * @param {EgressSchedule | undefined} aSched
 * @param {PricedRow} b
 * @param {EgressSchedule | undefined} bSched
 * @returns {{ gb: number, cheaperBelow: 'a' | 'b', cheaperAbove: 'a' | 'b' } | null}
 */
export function crossover(a, aSched, b, bSched) {
  const diff = (gb) =>
    effectiveMonthly(a, aSched, gb).total - effectiveMonthly(b, bSched, gb).total;

  const start = Math.sign(diff(0));
  if (start === 0) return null;

  const scan = [0, 50, 100, 250, 500, 1024, 2048, 5120, 10240, 20480, 51200, 102400];
  let lo = 0;
  let hi = null;
  for (const gb of scan) {
    const s = Math.sign(diff(gb));
    if (s !== start && s !== 0) { hi = gb; break; }
    lo = gb;
  }
  if (hi === null) return null;

  // Narrow to a usable figure rather than reporting the whole bracket.
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (Math.sign(diff(mid)) === start) lo = mid; else hi = mid;
  }
  return {
    gb: Math.round(hi),
    cheaperBelow: start < 0 ? 'a' : 'b',
    cheaperAbove: start < 0 ? 'b' : 'a',
  };
}
