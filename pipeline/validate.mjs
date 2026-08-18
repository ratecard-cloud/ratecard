import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PROVIDERS, ROOT } from './lib.mjs';

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

/**
 * Affiliate links are the one place where money could quietly bend the site,
 * so the registry is checked rather than trusted.
 */
export function validateProviders() {
  const errors = [];
  const warnings = [];

  for (const [key, p] of Object.entries(PROVIDERS)) {
    if (!['compute', 'object-storage'].includes(p.kind)) {
      errors.push(`${key}: bad kind "${p.kind}"`);
    }
    if (p.coverage_tolerance != null &&
        !(typeof p.coverage_tolerance === 'number' && p.coverage_tolerance > 0 && p.coverage_tolerance < 1)) {
      errors.push(`${key}: coverage_tolerance must be a fraction in (0, 1), got ${JSON.stringify(p.coverage_tolerance)}`);
    }
    if (p.affiliate == null) continue;

    if (typeof p.affiliate !== 'string' || !/^https:\/\//.test(p.affiliate)) {
      errors.push(`${key}: affiliate link must be an https URL, got ${JSON.stringify(p.affiliate)}`);
    }
    // A referral link pointing at our own pricing source would mean the
    // "source" links had quietly become monetised.
    if (p.affiliate === p.url) {
      errors.push(`${key}: affiliate URL is identical to the source URL — source links must stay untracked`);
    }
  }

  const withAff = Object.keys(PROVIDERS).filter((k) => PROVIDERS[k].affiliate);
  if (withAff.length) {
    warnings.push(
      `affiliate links active for: ${withAff.join(', ')} — confirm /methodology#independence still describes this accurately`,
    );
  }
  return { errors, warnings };
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

/* ---------------------------------------------------------------------------
 * Coverage regression: compare what we are about to publish against what we
 * last published.
 *
 * A collector that throws or skips is caught and the run continues — right for
 * local dev, dangerous in CI: an expired token silently publishes a dataset
 * with that provider gone, and the global record-count floor cannot see it
 * (four providers can vanish and still clear it). The previously committed
 * normalized files are the baseline, so the check maintains itself.
 * ------------------------------------------------------------------------- */

/** Records per provider/region, e.g. {"hetzner/us-east": 13}. */
function coverageMap(records) {
  const m = new Map();
  for (const r of records) {
    const k = `${r.provider}/${r.region}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

async function loadPrevious(category) {
  try {
    return JSON.parse(
      await readFile(resolve(ROOT, `data/normalized/${category}.json`), 'utf8'),
    );
  } catch {
    return null; // first run, or file unreadable — nothing to compare against
  }
}

/**
 * Fails closed: coverage that existed in the last published dataset must not
 * vanish or shrink sharply without an explicit override.
 *
 *   - previously present, now zero            -> error
 *   - shrunk by more than DROP_ERROR (30%)    -> error
 *   - shrunk at all                           -> warning
 *   - grown or new                            -> fine
 *
 * Intentional removals: ALLOW_COVERAGE_DROP="hetzner,gcp" or "all".
 */
export async function validatePreviousCoverage(compute, egress, statuses = {}) {
  const errors = [];
  const warnings = [];
  // Default drop threshold; a provider can widen it via coverage_tolerance in
  // providers.json. DigitalOcean carries 0.5 because its sizes.regions array
  // reflects LIVE CAPACITY, not pricing — fra1 shed 24 of 63 qualifying sizes
  // in seven hours the first day this check ran in CI, and that churn is
  // normal for DO. Vanishing to zero stays fatal for everyone regardless.
  //
  // Known limitation: the baseline is always the previous run, so repeated
  // just-under-threshold drops could ratchet coverage down over many days
  // without ever erroring. Every drop still warns, and a broken collector
  // manifests as zero (always fatal), so the ratchet needs a slow, sustained,
  // sub-threshold decline to slip through.
  const DROP_ERROR = 0.3;
  const dropThreshold = (provider) => {
    const t = PROVIDERS[provider]?.coverage_tolerance;
    return typeof t === 'number' && t > 0 && t < 1 ? t : DROP_ERROR;
  };

  const allowed = new Set(
    (process.env.ALLOW_COVERAGE_DROP ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const isAllowed = (provider) => allowed.has('all') || allowed.has(provider);

  for (const [category, current] of [
    ['compute', compute],
    ['egress', egress],
  ]) {
    const previous = await loadPrevious(category);
    if (!previous) {
      warnings.push(`${category}: no previous dataset to compare against — coverage check skipped`);
      continue;
    }

    const prev = coverageMap(previous);
    const cur = coverageMap(current);

    for (const [key, oldCount] of prev) {
      const provider = key.split('/')[0];
      const newCount = cur.get(key) ?? 0;
      if (newCount >= oldCount) continue;

      // Collector status makes the error actionable: "skipped: token not set"
      // points at the fix, a bare count does not.
      const st = statuses[provider];
      const why = st && st.state !== 'ok' ? ` (collector ${st.state}: ${st.reason ?? st.error ?? ''})` : '';

      if (newCount === 0) {
        if (isAllowed(provider)) {
          warnings.push(`${category} ${key}: coverage removed (${oldCount} -> 0), allowed by override${why}`);
        } else {
          errors.push(
            `${category} ${key}: previously published ${oldCount} records, now ZERO${why} — ` +
              `refusing to publish. Set ALLOW_COVERAGE_DROP=${provider} if intentional.`,
          );
        }
      } else if ((oldCount - newCount) / oldCount > dropThreshold(provider)) {
        if (isAllowed(provider)) {
          warnings.push(`${category} ${key}: ${oldCount} -> ${newCount}, allowed by override`);
        } else {
          errors.push(
            `${category} ${key}: dropped ${oldCount} -> ${newCount} ` +
              `(-${Math.round(100 * (oldCount - newCount) / oldCount)}%)${why} — ` +
              `over the ${dropThreshold(provider) * 100}% threshold. Set ALLOW_COVERAGE_DROP=${provider} if intentional.`,
          );
        }
      } else {
        warnings.push(`${category} ${key}: ${oldCount} -> ${newCount} — small shrink, publishing anyway`);
      }
    }
  }
  return { errors, warnings };
}
