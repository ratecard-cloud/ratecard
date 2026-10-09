import { createHash } from 'node:crypto';
import { getJSON, saveRaw, computeRecord, isTargetShape, PROVIDERS, HOURS_PER_MONTH } from '../lib.mjs';

const SOURCE = 'https://www.ovhcloud.com/en/public-cloud/prices/';

/**
 * OVHcloud sells US regions through a separate entity (OVHcloud US) with its
 * own catalog; everywhere else is priced in USD under the international "WE"
 * subsidiary. Both catalogs are public and need no credentials.
 *
 * Prices are free; AVAILABILITY is not. The pricing catalog quotes a plan
 * without saying where it can be ordered — the exact gap that once let retired
 * Hetzner types publish as live prices. So:
 *
 *   US regions   the US catalog carries explicit `region` configurations on
 *                some of a model's addons. Only models with a stated region
 *                are published; a model with none (c3 today) is unknown and
 *                omitted rather than assumed.
 *   DE1, SGP1    need /cloud/order/rule/availability, which is authenticated:
 *                OVH_APPLICATION_KEY, OVH_APPLICATION_SECRET, OVH_CONSUMER_KEY
 *                (read-only, GET on that one path). Without them these regions
 *                are skipped, never guessed.
 */
export const CATALOG = {
  US: 'https://api.us.ovhcloud.com/1.0/order/catalog/public/cloud?ovhSubsidiary=US',
  WE: 'https://ca.api.ovh.com/1.0/order/catalog/public/cloud?ovhSubsidiary=WE',
};
// Keys belong to one API endpoint. International (WE) accounts live on the CA
// endpoint; an EU account would set OVH_ENDPOINT=https://eu.api.ovh.com/1.0.
const ENDPOINT = () => process.env.OVH_ENDPOINT ?? 'https://ca.api.ovh.com/1.0';

const subsidiaryOf = (code) => (code.startsWith('US-') ? 'US' : 'WE');

// Catalogs are 2-8 MB; compute and egress both read them, so fetch once per run.
const catalogs = new Map();
export function catalog(sub) {
  if (!catalogs.has(sub)) catalogs.set(sub, getJSON(CATALOG[sub]));
  return catalogs.get(sub);
}

/** OVH request signing: "$1$" + sha1(AS+CK+METHOD+URL+BODY+TIMESTAMP, "+"-joined). */
async function signedGet(path) {
  const base = ENDPOINT();
  const url = `${base}${path}`;
  const ts = String(await getJSON(`${base}/auth/time`));
  const sig = createHash('sha1')
    .update([process.env.OVH_APPLICATION_SECRET, process.env.OVH_CONSUMER_KEY, 'GET', url, '', ts].join('+'))
    .digest('hex');
  return getJSON(url, {
    headers: {
      'x-ovh-application': process.env.OVH_APPLICATION_KEY,
      'x-ovh-consumer': process.env.OVH_CONSUMER_KEY,
      'x-ovh-timestamp': ts,
      'x-ovh-signature': `$1$${sig}`,
    },
  });
}

const hasKeys = () =>
  ['OVH_APPLICATION_KEY', 'OVH_APPLICATION_SECRET', 'OVH_CONSUMER_KEY'].every((k) => process.env[k]);

// b3-8.consumption, d2-4.monthly.postpaid, d2-4.monthly (a region-config stub).
// Two-dash names (win-b2-7, vps-ssd-3) are Windows-licensed or legacy VPS.
const PLAN = /^([a-z][a-z0-9]*-\d+)\.(consumption|monthly\.postpaid|monthly)$/;

const FAMILY = {
  'general-purpose': 'General Purpose',
  cpu: 'Compute Optimized',
  ram: 'Memory Optimized',
  discovery: 'Discovery',
};

/** Group a catalog's instance addons by model, keeping what the record needs. */
function models(cat) {
  const out = new Map();
  for (const a of cat.addons) {
    if (a.product !== 'publiccloud-instance') continue;
    const m = PLAN.exec(a.planCode);
    if (!m) continue;
    const [, model, billing] = m;
    const e = out.get(model) ?? { model, regions: new Set() };
    for (const c of a.configurations ?? []) {
      if (c.name === 'region') for (const r of c.values ?? []) e.regions.add(r);
    }
    // Catalog prices are integers in 1e-8 of the currency unit.
    const price = (a.pricings?.[0]?.price ?? 0) / 1e8;
    if (billing === 'consumption') {
      e.hourly = price;
      e.blobs = a.blobs;
    } else if (billing === 'monthly.postpaid' && price > 0) {
      e.monthly = price;
    }
    out.set(model, e);
  }
  return out;
}

/** The addons a replay needs: instance plans of target shapes, nothing else. */
function retained(cat) {
  const keep = new Set(
    [...models(cat).values()]
      .filter((e) => isTargetShape(e.blobs?.technical?.cpu?.cores, e.blobs?.technical?.memory?.size))
      .map((e) => e.model),
  );
  return {
    locale: cat.locale,
    addons: cat.addons.filter((a) => a.product === 'publiccloud-instance' && keep.has(PLAN.exec(a.planCode)?.[1])),
  };
}

export default async function collect() {
  const regions = PROVIDERS.ovh.regions;
  const [us, we] = await Promise.all([catalog('US'), catalog('WE')]);
  for (const [sub, cat] of [['US', us], ['WE', we]]) {
    if (cat.locale?.currencyCode !== 'USD') {
      throw new Error(`ovh ${sub} catalog priced in ${cat.locale?.currencyCode}, expected USD`);
    }
  }

  // WE availability, by plan code. null = no keys, so WE regions are skipped.
  let weAvail = null;
  if (hasKeys()) {
    const body = await signedGet('/cloud/order/rule/availability?ovhSubsidiary=WE');
    weAvail = new Map((body.plans ?? []).map((p) => [p.code, new Set(p.regions ?? [])]));
  } else {
    console.log('  ovh: OVH_APPLICATION_KEY/SECRET/CONSUMER_KEY not set — DE1 and SGP1 skipped (see README "Credentials")');
  }
  await saveRaw('ovh', 'compute', {
    US: retained(us),
    WE: retained(we),
    availability: weAvail && Object.fromEntries([...weAvail].map(([k, v]) => [k, [...v]])),
  });

  const bySub = { US: models(us), WE: models(we) };
  const out = [];
  for (const [canonical, code] of Object.entries(regions)) {
    const sub = subsidiaryOf(code);
    if (sub === 'WE' && !weAvail) continue;

    for (const e of bySub[sub].values()) {
      const t = e.blobs?.technical;
      if (!t || e.hourly == null || e.hourly <= 0) continue;
      const tags = e.blobs.tags ?? [];
      if (tags.includes('legacy') || !tags.includes('active')) continue;
      const vcpu = t.cpu?.cores;
      const ram_gb = t.memory?.size;
      if (!isTargetShape(vcpu, ram_gb)) continue;

      const orderable = sub === 'US'
        ? e.regions.has(code)
        : [`${e.model}.consumption`, `${e.model}.monthly.postpaid`].some((p) => weAvail.get(p)?.has(code));
      if (!orderable) continue;

      const subtype = e.blobs.commercial?.brickSubtype;
      const bw = t.bandwidth ?? {};
      const disks = t.storage?.disks ?? [];
      const apac = canonical === 'ap-southeast';
      out.push(
        computeRecord({
          provider: 'ovh',
          region: canonical,
          region_code: code,
          sku: e.model,
          display_name: e.model.toUpperCase(),
          vcpu,
          // Discovery (d2) runs on shared resources; every other range is
          // sold as "guaranteed resources" — dedicated vCores.
          vcpu_type: subtype === 'discovery' ? 'shared' : 'dedicated',
          // An OVH vCore is a hyperthread.
          vcpu_unit: 'thread',
          ram_gb,
          arch: 'x86_64',
          local_storage_gb: disks.reduce((s, d) => s + (d.capacity ?? 0) * (d.number ?? 1), 0),
          // Traffic is not bundled per instance: it is unmetered outside APAC
          // and a per-project allowance in APAC — both live on the egress schedule.
          included_egress_gb: 0,
          price_hourly_usd: e.hourly,
          price_monthly_usd: e.monthly ?? e.hourly * HOURS_PER_MONTH,
          source_url: SOURCE,
          confidence: 'high',
          notes: [
            FAMILY[subtype] ?? subtype,
            e.monthly
              ? `Monthly billing ($${e.monthly.toFixed(2)}) commits to the calendar month; hourly is $${e.hourly}/h ($${(e.hourly * HOURS_PER_MONTH).toFixed(2)} at 730 h).`
              : 'Hourly billing only; monthly is hourly × 730.',
            `Public bandwidth ${bw.level} Mbit/s, ${bw.guaranteed ? 'guaranteed' : 'best effort'}` +
              (apac ? '.' : '; traffic is unmetered, so throughput, not volume, is the limit.'),
            sub === 'US' ? 'Sold by OVHcloud US, a separate account from OVHcloud international.' : null,
          ].filter(Boolean),
        }),
      );
    }
  }
  return out;
}
