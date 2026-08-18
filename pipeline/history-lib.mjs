/**
 * Price-history materialization: pure functions only.
 *
 * Git holds the history but nothing can query it — CI checkouts are shallow
 * and the site build cannot walk commits. So history lives as committed files
 * under data/history/, appended to incrementally each run:
 *
 *   state.json   internal: the last snapshot seen, for diffing (not served)
 *   series.json  per SKU: price as run-length segments (flat prices stay tiny)
 *   changes.json chronological events: the public changelog
 *
 * Everything here is deterministic given (state, snapshot, date), which is
 * what makes it testable and same-day reruns safe.
 */

const key = (r) => `${r.provider}/${r.region}/${r.sku}`;
const eKey = (r) => `${r.provider}/${r.region}`;

/** The comparable part of an egress schedule — trust fields excluded. */
export function egressSig(rec) {
  return {
    free_gb_per_month: rec.free_gb_per_month ?? null,
    bundled_with_compute: rec.bundled_with_compute ?? false,
    tiers: rec.tiers,
  };
}

/** Reduce a normalized dataset to the fields history tracks. */
export function snapshotOf(compute, egress) {
  const c = {};
  for (const r of compute) {
    c[key(r)] = {
      hourly: r.price_hourly_usd,
      monthly: r.price_monthly_usd,
      included_egress_gb: r.included_egress_gb ?? 0,
    };
  }
  const e = {};
  for (const r of egress) e[eKey(r)] = egressSig(r);
  return { compute: c, egress: e };
}

/**
 * Events that turn `prev` into `next`. Ordering is stable (sorted by key) so
 * reruns produce identical output.
 */
export function diffSnapshots(prev, next, date) {
  const events = [];
  const keys = [...new Set([...Object.keys(prev.compute), ...Object.keys(next.compute)])].sort();

  for (const k of keys) {
    const [provider, region, ...rest] = k.split('/');
    const sku = rest.join('/');
    const a = prev.compute[k];
    const b = next.compute[k];

    if (!a && b) {
      events.push({ date, type: 'sku_added', provider, region, sku, monthly: b.monthly });
    } else if (a && !b) {
      events.push({ date, type: 'sku_removed', provider, region, sku, monthly: a.monthly });
    } else if (a && b) {
      if (a.monthly !== b.monthly || a.hourly !== b.hourly) {
        events.push({
          date, type: 'price_changed', provider, region, sku,
          monthly_old: a.monthly, monthly_new: b.monthly,
          hourly_old: a.hourly, hourly_new: b.hourly,
        });
      }
      if (a.included_egress_gb !== b.included_egress_gb) {
        events.push({
          date, type: 'allowance_changed', provider, region, sku,
          included_gb_old: a.included_egress_gb, included_gb_new: b.included_egress_gb,
        });
      }
    }
  }

  const eks = [...new Set([...Object.keys(prev.egress), ...Object.keys(next.egress)])].sort();
  for (const k of eks) {
    const [provider, region] = k.split('/');
    const a = prev.egress[k];
    const b = next.egress[k];
    if (a && b && JSON.stringify(a) !== JSON.stringify(b)) {
      events.push({ date, type: 'egress_changed', provider, region, old: a, new: b });
    } else if (!a && b) {
      events.push({ date, type: 'egress_added', provider, region, new: b });
    } else if (a && !b) {
      events.push({ date, type: 'egress_removed', provider, region, old: a });
    }
  }
  return events;
}

/**
 * Fold one day's snapshot into the series. Run-length encoding: a new segment
 * only when the price actually changes, so years of flat prices stay small.
 * Same-day rerun: the segment for `date` is replaced, not duplicated.
 */
export function appendToSeries(series, snapshot, date) {
  const out = structuredClone(series);

  for (const [k, cur] of Object.entries(snapshot.compute)) {
    let s = out[k];
    if (!s) {
      s = out[k] = { first_seen: date, segments: [] };
    }
    delete s.removed; // present again (or still)
    const last = s.segments[s.segments.length - 1];
    if (last && last.hourly === cur.hourly && last.monthly === cur.monthly) {
      // unchanged: the open segment simply continues
    } else if (last && last.since === date) {
      // same-day rerun with a different price: today's segment is corrected
      last.hourly = cur.hourly;
      last.monthly = cur.monthly;
    } else {
      s.segments.push({ since: date, hourly: cur.hourly, monthly: cur.monthly });
    }
    s.last_seen = date;
  }

  // Anything tracked but absent today is marked removed (once).
  for (const [k, s] of Object.entries(out)) {
    if (!snapshot.compute[k] && !s.removed) s.removed = date;
  }
  return out;
}

/**
 * One incremental step: returns the new state, series, and changes.
 * Idempotent for a same-day rerun: events for `date` are recomputed against
 * the last snapshot from BEFORE `date`, never against the same day's earlier
 * run — so a morning/midday double run cannot double-report.
 */
export function step(history, compute, egress, date) {
  const { state, series, changes } = history;
  const snapshot = snapshotOf(compute, egress);

  // Baseline for diffing: if we already ran today, diff from the pre-today
  // state we stored; otherwise from the current state.
  const baseline = state.as_of === date && state.previous ? state.previous : state.snapshot;

  const events = baseline ? diffSnapshots(baseline, snapshot, date) : [];
  const keptChanges = changes.filter((c) => c.date !== date).concat(events);

  return {
    state: {
      as_of: date,
      // Keep the pre-today snapshot until the day rolls over, for rerun safety.
      previous: state.as_of === date ? state.previous : state.snapshot,
      snapshot,
    },
    series: appendToSeries(series, snapshot, date),
    changes: keptChanges,
  };
}

export const emptyHistory = () => ({
  state: { as_of: null, previous: null, snapshot: null },
  series: {},
  changes: [],
});
