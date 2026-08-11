import { PROVIDERS } from './lib.mjs';

/**
 * Sanity gates that run before anything is written. The failure mode this site
 * cannot survive is publishing a wrong number confidently, so a bad record fails
 * the build rather than shipping with a warning nobody reads.
 */
const REGIONS = ['us-east', 'eu-central'];

export function validateCompute(records) {
  const errors = [];
  const warnings = [];
  const seen = new Set();

  for (const r of records) {
    const id = `${r.provider}/${r.region}/${r.sku}`;

    if (!PROVIDERS[r.provider]) errors.push(`${id}: unknown provider`);
    if (!REGIONS.includes(r.region)) errors.push(`${id}: unknown region "${r.region}"`);
    if (seen.has(id)) errors.push(`${id}: duplicate record`);
    seen.add(id);

    if (!(r.price_monthly_usd > 0)) errors.push(`${id}: non-positive monthly price`);
    if (!(r.price_hourly_usd > 0)) errors.push(`${id}: non-positive hourly price`);
    if (!/^https:\/\//.test(r.source_url ?? '')) errors.push(`${id}: missing source_url`);
    if (!['high', 'medium', 'low'].includes(r.confidence)) {
      errors.push(`${id}: bad confidence "${r.confidence}"`);
    }

    // Hourly and monthly must agree within rounding, or one of them is stale —
    // unless the collector already explained the gap (e.g. a monthly billing cap).
    const implied = r.price_hourly_usd * 730;
    const drift = Math.abs(implied - r.price_monthly_usd) / r.price_monthly_usd;
    const explained = r.notes?.some((n) => /cap|commit|discount/i.test(n));
    if (drift > 0.02 && !explained) {
      warnings.push(
        `${id}: hourly*730 ($${implied.toFixed(2)}) differs from monthly ` +
          `($${r.price_monthly_usd}) by ${(drift * 100).toFixed(0)}% — ` +
          `provider likely discounts monthly commitments`,
      );
    }

    // Absurdity guards: catch a unit-conversion bug before it reaches the site.
    const perVcpu = r.price_monthly_usd / r.vcpu;
    if (perVcpu > 500) errors.push(`${id}: $${perVcpu.toFixed(2)}/vCPU/mo looks wrong`);
    if (perVcpu < 0.5) errors.push(`${id}: $${perVcpu.toFixed(2)}/vCPU/mo looks wrong`);
    if (r.ram_gb > 4096) errors.push(`${id}: ram_gb ${r.ram_gb} looks wrong`);
    if (r.included_egress_gb > 1e6) {
      errors.push(`${id}: included_egress_gb ${r.included_egress_gb} looks like a unit bug`);
    }
  }
  return { errors, warnings };
}

export function validateEgress(records) {
  const errors = [];
  const seen = new Set();

  for (const r of records) {
    const id = `${r.provider}/${r.region}`;
    if (seen.has(id)) errors.push(`egress ${id}: duplicate`);
    seen.add(id);

    if (!r.tiers?.length) errors.push(`egress ${id}: no tiers`);
    let last = 0;
    for (const t of r.tiers) {
      if (t.usd_per_gb == null || t.usd_per_gb < 0) {
        errors.push(`egress ${id}: bad rate ${t.usd_per_gb}`);
      }
      if (t.usd_per_gb > 1) errors.push(`egress ${id}: $${t.usd_per_gb}/GB looks wrong`);
      if (t.up_to_gb != null) {
        if (t.up_to_gb <= last) errors.push(`egress ${id}: tiers not ascending`);
        last = t.up_to_gb;
      }
    }
    if (r.tiers.at(-1).up_to_gb != null) {
      errors.push(`egress ${id}: final tier must be unbounded (up_to_gb: null)`);
    }
  }
  return { errors, warnings: [] };
}

/** Cross-dataset check: every compute provider needs an egress schedule. */
export function validateCoverage(compute, egress) {
  const errors = [];
  const have = new Set(egress.map((e) => `${e.provider}/${e.region}`));
  for (const c of compute) {
    const k = `${c.provider}/${c.region}`;
    if (!have.has(k)) {
      errors.push(`no egress schedule for ${k} — effective-cost column would be blank`);
    }
  }
  return { errors: [...new Set(errors)], warnings: [] };
}
