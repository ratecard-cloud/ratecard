import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT, getJSON, saveRaw, PROVIDERS, round, HOURS_PER_MONTH } from '../lib.mjs';

/**
 * The cost of ONE public IPv4 on a running instance, per month.
 *
 * This became a real line item when AWS started charging in 2024 (~$44/year
 * per address); Azure and GCP charge similarly, Hetzner charges a little,
 * and the value providers still bundle it. The definition used here: what you
 * pay per month to have the address, where that payment is avoidable or
 * itemised; $0 where it is bundled with no listed price.
 */

function rec(provider, canonical, o) {
  return {
    provider,
    region: canonical,
    region_code: PROVIDERS[provider].regions[canonical] ?? null,
    sku: 'public-ipv4',
    display_name: o.display_name ?? 'Public IPv4 address',
    usd_per_month: round(o.usd_per_month, 4),
    usd_per_hour: o.usd_per_hour != null ? round(o.usd_per_hour, 6) : null,
    included_with_instance: o.included_with_instance ?? false,
    currency: 'USD',
    source_url: o.source_url,
    collected_at: new Date().toISOString(),
    source_verified_at: o.source_verified_at ?? null,
    confidence: o.confidence,
    notes: o.notes ?? [],
  };
}

async function aws() {
  // The AmazonVPC offer file is ~28 KB per region — no streaming needed.
  const out = [];
  const raw = {};
  for (const [canonical, code] of Object.entries(PROVIDERS.aws.regions)) {
    const url = `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonVPC/current/${code}/index.json`;
    const body = await getJSON(url);
    let hourly = null;
    for (const p of Object.values(body.products ?? {})) {
      if (p.attributes?.usagetype?.endsWith('PublicIPv4:InUseAddress')) {
        const sku = p.sku;
        for (const term of Object.values(body.terms?.OnDemand?.[sku] ?? {})) {
          for (const dim of Object.values(term.priceDimensions ?? {})) {
            hourly = parseFloat(dim.pricePerUnit?.USD ?? '0');
          }
        }
      }
    }
    if (hourly == null || !(hourly > 0)) continue;
    raw[canonical] = hourly;
    out.push(
      rec('aws', canonical, {
        display_name: 'Public IPv4 (in use)',
        usd_per_hour: hourly,
        usd_per_month: hourly * HOURS_PER_MONTH,
        source_url: 'https://aws.amazon.com/vpc/pricing/',
        confidence: 'high',
        notes: ['Charged since February 2024, idle or in use. Applies to every public IPv4 including the instance default.'],
      }),
    );
  }
  await saveRaw('aws', 'ipv4', raw);
  return out;
}

async function azure() {
  const out = [];
  const raw = {};
  for (const [canonical, code] of Object.entries(PROVIDERS.azure.regions)) {
    const filter =
      `serviceName eq 'Virtual Network' and armRegionName eq '${code}' and priceType eq 'Consumption'`;
    const body = await getJSON(
      `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}`,
    );
    const m = body.Items.find(
      (i) => i.meterName === 'Standard IPv4 Static Public IP' && i.unitOfMeasure === '1 Hour',
    );
    if (!m) continue;
    raw[canonical] = m;
    out.push(
      rec('azure', canonical, {
        display_name: 'Standard static public IP',
        usd_per_hour: m.retailPrice,
        usd_per_month: m.retailPrice * HOURS_PER_MONTH,
        source_url: 'https://azure.microsoft.com/en-us/pricing/details/ip-addresses/',
        confidence: 'high',
        notes: ['Standard SKU static, the default for new deployments. Basic SKU is retired.'],
      }),
    );
  }
  await saveRaw('azure', 'ipv4', raw);
  return out;
}

async function gcp() {
  const key = process.env.GCP_API_KEY;
  if (!key) return { skipped: 'GCP_API_KEY not set — see README "Credentials"' };

  const skus = [];
  let token = '';
  do {
    const url =
      `https://cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus` +
      `?key=${key}&pageSize=5000${token ? `&pageToken=${token}` : ''}`;
    const body = await getJSON(url);
    skus.push(...(body.skus ?? []));
    token = body.nextPageToken;
  } while (token);

  const relevant = skus.filter(
    (s) => /^External IP Charge on a Standard VM/i.test(s.description) && s.category?.usageType === 'OnDemand',
  );
  await saveRaw('gcp', 'ipv4', relevant);

  const unitPrice = (sku) => {
    const r = sku.pricingInfo?.[0]?.pricingExpression?.tieredRates?.at(-1)?.unitPrice;
    return r ? Number(r.units ?? 0) + (r.nanos ?? 0) / 1e9 : null;
  };

  const out = [];
  for (const [canonical, code] of Object.entries(PROVIDERS.gcp.regions)) {
    const sku = relevant.find((s) => s.serviceRegions?.includes(code)) ?? relevant.find((s) => s.serviceRegions?.includes('global'));
    const hourly = sku && unitPrice(sku);
    if (hourly == null) continue;
    out.push(
      rec('gcp', canonical, {
        display_name: 'External IPv4 (in use, standard VM)',
        usd_per_hour: hourly,
        usd_per_month: hourly * HOURS_PER_MONTH,
        source_url: 'https://cloud.google.com/vpc/network-pricing#ipaddress',
        confidence: 'high',
        notes: ['Charged while attached to a running standard VM; idle reserved addresses cost more.'],
      }),
    );
  }
  return out;
}

async function hetzner() {
  const token = process.env.HETZNER_API_TOKEN;
  if (!token) return { skipped: 'HETZNER_API_TOKEN not set — see README "Credentials"' };
  const body = await getJSON('https://api.hetzner.cloud/v1/pricing', {
    headers: { authorization: `Bearer ${token}` },
  });
  const v4 = body.pricing.primary_ips.find((p) => p.type === 'ipv4');
  await saveRaw('hetzner', 'ipv4', v4);

  const out = [];
  for (const [canonical, code] of Object.entries(PROVIDERS.hetzner.regions)) {
    const loc = v4.prices.find((p) => p.location === code);
    if (!loc) continue;
    out.push(
      rec('hetzner', canonical, {
        display_name: 'Primary IPv4',
        usd_per_month: parseFloat(loc.price_monthly.net),
        usd_per_hour: parseFloat(loc.price_hourly.net),
        source_url: 'https://www.hetzner.com/cloud/',
        confidence: 'high',
        notes: ['Optional: servers can be created IPv6-only and skip this entirely. Net of VAT.'],
      }),
    );
  }
  return out;
}

async function vultr() {
  /**
   * Vultr publishes no IPv4 line item, but it publishes something better: an
   * IPv6-only variant of a plan at a lower price. The delta between identical
   * plans with and without IPv4 IS the IPv4 price, derived from their own API.
   */
  const body = await getJSON('https://api.vultr.com/v2/plans?per_page=500');
  const v6 = body.plans.find((p) => /-v6$/.test(p.id));
  const base = v6 && body.plans.find((p) => p.id === v6.id.replace(/-v6$/, ''));
  if (!v6 || !base) throw new Error('vultr: v6-only plan pair not found — cannot derive IPv4 price');
  await saveRaw('vultr', 'ipv4', { v6: v6.id, base: base.id, delta: base.monthly_cost - v6.monthly_cost });

  const delta = round(base.monthly_cost - v6.monthly_cost, 2);
  return Object.keys(PROVIDERS.vultr.regions).map((canonical) =>
    rec('vultr', canonical, {
      display_name: 'IPv4 (vs IPv6-only plan)',
      usd_per_month: delta,
      included_with_instance: true,
      source_url: 'https://www.vultr.com/pricing/',
      confidence: 'high',
      notes: [
        `Derived: the IPv6-only variant of ${base.id} is exactly $${delta}/month cheaper than the IPv4 version — Vultr's imputed IPv4 price, from their own plans API.`,
        'Bundled into standard plan prices; avoidable by choosing an IPv6-only plan.',
      ],
    }),
  );
}

async function curated() {
  const file = JSON.parse(await readFile(resolve(ROOT, 'data/curated/ipv4.json'), 'utf8'));
  const out = [];
  for (const [provider, c] of Object.entries(file)) {
    if (provider.startsWith('_')) continue;
    for (const canonical of Object.keys(PROVIDERS[provider].regions)) {
      out.push(rec(provider, canonical, c));
    }
  }
  return out;
}

export default async function collect() {
  const out = [];
  const statuses = {};
  for (const [name, fn] of Object.entries({ aws, azure, gcp, hetzner, vultr, curated })) {
    try {
      const res = await fn();
      if (res && !Array.isArray(res) && res.skipped) {
        statuses[name] = { state: 'skipped', reason: res.skipped };
        continue;
      }
      out.push(...res);
      statuses[name] = { state: 'ok', records: res.length };
    } catch (err) {
      statuses[name] = { state: 'failed', error: String(err.message ?? err) };
    }
  }
  return { records: out, statuses };
}
