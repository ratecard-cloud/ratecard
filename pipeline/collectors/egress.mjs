import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { ROOT, getJSON, saveRaw, PROVIDERS, round } from '../lib.mjs';

/* ------------------------------------------------------------------ AWS -- */

const AWS_DT_URL =
  'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/index.csv';

const AWS_FROM = {
  'us-east': 'US East (N. Virginia)',
  'eu-central': 'EU (Frankfurt)',
  'us-west': 'US West (Oregon)',
  'ap-southeast': 'Asia Pacific (Singapore)',
};

function splitCSV(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Inter-region rows harvested during the same stream — the data-transfer CSV
 * carries them alongside the internet-egress rows, and the interregion
 * collector reads this after egress has run.
 */
export const awsInterRegionHarvest = [];

async function awsSchedules() {
  const cached = resolve(ROOT, 'data/cache/aws-datatransfer.csv');
  const input = existsSync(cached)
    ? createReadStream(cached, 'utf8')
    : Readable.fromWeb((await fetch(AWS_DT_URL)).body);

  const rl = createInterface({ input, crlfDelay: Infinity });
  let header = null; let skipped = 0;
  const byRegion = {};

  for await (const line of rl) {
    if (!header) {
      if (skipped < 5) { skipped++; continue; }
      header = splitCSV(line);
      continue;
    }
    const f = splitCSV(line);
    const r = {};
    for (let i = 0; i < header.length; i++) r[header[i]] = f[i];

    if (r.TermType !== 'OnDemand') continue;

    if (r['Transfer Type'] === 'InterRegion Outbound' && r.Unit === 'GB') {
      const from = Object.keys(AWS_FROM).find((k) => AWS_FROM[k] === r['From Location']);
      const to = Object.keys(AWS_FROM).find((k) => AWS_FROM[k] === r['To Location']);
      if (from && to && from !== to) {
        awsInterRegionHarvest.push({ from, to, usd_per_gb: parseFloat(r.PricePerUnit) });
      }
      continue;
    }

    if (r['Transfer Type'] !== 'AWS Outbound') continue;
    if (r['To Location'] !== 'External') continue;
    if (r.Unit !== 'GB') continue;

    const canonical = Object.keys(AWS_FROM).find((k) => AWS_FROM[k] === r['From Location']);
    if (!canonical) continue;

    (byRegion[canonical] ??= []).push({
      start: parseFloat(r.StartingRange || '0'),
      end: r.EndingRange === 'Inf' ? null : parseFloat(r.EndingRange),
      price: parseFloat(r.PricePerUnit),
    });
  }

  const out = {};
  for (const [canonical, rows] of Object.entries(byRegion)) {
    rows.sort((a, b) => a.start - b.start);
    out[canonical] = {
      // The 100 GB/month free tier is an account-level allowance and does not
      // appear in the price list file; it comes from the free-tier page.
      free_gb_per_month: 100,
      bundled_with_compute: false,
      tiers: rows.map((t) => ({ up_to_gb: t.end, usd_per_gb: round(t.price, 6) })),
      notes: [
        'First 100 GB/month outbound is free account-wide across all services and regions.',
        'Inter-AZ and inter-region transfer are billed separately and are not included here.',
      ],
    };
  }
  return out;
}

/* ---------------------------------------------------------------- Azure -- */

/**
 * Azure publishes two ladders per region: "Rtn Preference: MGN" (Microsoft
 * Global Network — the DEFAULT) and "Bandwidth - Routing Preference: Internet"
 * (cheaper opt-in ISP routing). We index the default; picking the cheaper one
 * would flatter Azure against a setting most users never change.
 */
async function azureSchedules() {
  const out = {};
  const raw = {};
  for (const [canonical, code] of Object.entries(PROVIDERS.azure.regions)) {
    const filter =
      `serviceName eq 'Bandwidth' and armRegionName eq '${code}' and priceType eq 'Consumption'`;
    const body = await getJSON(
      `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}`,
    );
    raw[canonical] = body.Items;

    const rows = body.Items.filter(
      (i) =>
        i.meterName === 'Standard Data Transfer Out' &&
        /MGN/i.test(i.productName) &&
        i.unitOfMeasure === '1 GB',
    );
    // Dedupe on (tierMinimumUnits, retailPrice); Azure repeats meters per SKU.
    const seen = new Map();
    for (const i of rows) seen.set(`${i.tierMinimumUnits}:${i.retailPrice}`, i);
    const sorted = [...seen.values()].sort(
      (a, b) => a.tierMinimumUnits - b.tierMinimumUnits,
    );
    if (!sorted.length) continue;

    // The tierMin=0 / $0 row IS the free allowance; its width is the next tier's floor.
    const freeRow = sorted.find((r) => r.retailPrice === 0);
    const paid = sorted.filter((r) => r.retailPrice > 0);
    const free_gb = freeRow ? paid[0]?.tierMinimumUnits ?? 0 : 0;

    const tiers = paid.map((r, idx) => ({
      up_to_gb: paid[idx + 1] ? paid[idx + 1].tierMinimumUnits - free_gb : null,
      usd_per_gb: round(r.retailPrice, 6),
    }));

    out[canonical] = {
      free_gb_per_month: free_gb,
      bundled_with_compute: false,
      tiers,
      notes: [
        'Default Microsoft Global Network routing. Opting into "Routing Preference: Internet" is cheaper.',
        `First ${free_gb} GB/month free account-wide.`,
      ],
    };
  }
  await saveRaw('azure', 'egress', raw);
  return out;
}

/* ------------------------------------------------------------------ OCI -- */

/**
 * OCI's price list API carries tiered rates on a single part number, with
 * explicit rangeMin/rangeMax bounds — so the schedule is derivable exactly
 * rather than curated. Part numbers are not discoverable through the API and
 * were read off the published price list.
 *
 *   B88327  North America, Europe and UK   (both our regions)
 *   B93455  APAC, Japan, South America
 *   B93456  Middle East and Africa
 */
// NA/EU/UK share one part; APAC has its own at ~3x the rate ($0.025 vs $0.0085).
const OCI_PART = {
  'us-east': 'B88327',
  'eu-central': 'B88327',
  'us-west': 'B88327',
  'ap-southeast': 'B93455',
};
const OCI_API = 'https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/';

async function ociSchedules() {
  const out = {};
  const raw = {};

  for (const [canonical, part] of Object.entries(OCI_PART)) {
    const body = await getJSON(`${OCI_API}?partNumber=${part}`);
    const item = body.items?.[0];
    if (!item) throw new Error(`OCI egress part ${part} not found`);
    raw[canonical] = item;

    const usd = item.currencyCodeLocalizations.find((c) => c.currencyCode === 'USD');
    const bands = (usd?.prices ?? [])
      .filter((p) => p.model === 'PAY_AS_YOU_GO')
      .sort((a, b) => a.rangeMin - b.rangeMin);
    if (!bands.length) throw new Error(`OCI egress part ${part} has no USD PAYG price`);

    // A leading zero-priced band is the free allowance, not a tier.
    const free = bands[0].value === 0 ? bands[0].rangeMax : 0;
    const paid = bands.filter((b) => b.value > 0);

    out[canonical] = {
      free_gb_per_month: free,
      bundled_with_compute: false,
      // Tier bounds are absolute on OCI's side; ours are measured after the
      // free allowance is consumed, so shift them down by `free`.
      tiers: paid.map((b, i) => ({
        up_to_gb:
          i === paid.length - 1 || b.rangeMax > 1e12 ? null : round(b.rangeMax - free, 4),
        usd_per_gb: round(b.value, 6),
      })),
      notes: [
        `First ${free / 1024} TB/month outbound is free account-wide, not per instance.`,
        'This single allowance is why OCI wins most egress-heavy comparisons.',
        canonical === 'ap-southeast'
          ? 'APAC-originating rate — roughly 3x the North America / Europe rate.'
          : 'Rates differ by originating region; these are the North America / Europe / UK figures.',
      ],
    };
  }
  await saveRaw('oci', 'egress', raw);
  return out;
}

/* -------------------------------------------------------------- Hetzner -- */

/**
 * Hetzner publishes price_per_tb_traffic per location on /v1/pricing, so the
 * overage rate is exact rather than curated. Needs HETZNER_API_TOKEN; without
 * it we fall back to the curated entry, which is explicitly marked unverified.
 *
 * The bundled allowance itself lives on the compute records, because it varies
 * enormously by location (EU ~20 TiB, US 1-8 TiB) and even by server type.
 */
async function hetznerSchedules() {
  const token = process.env.HETZNER_API_TOKEN;
  if (!token) return null;

  const body = await getJSON('https://api.hetzner.cloud/v1/pricing', {
    headers: { authorization: `Bearer ${token}` },
  });
  await saveRaw('hetzner', 'egress', body);

  const currency = body.pricing.currency ?? 'EUR';
  const out = {};

  for (const [canonical, code] of Object.entries(PROVIDERS.hetzner.regions)) {
    // Every server type quotes the same per-TB rate at a given location.
    let perTb = null;
    for (const st of body.pricing.server_types) {
      const loc = st.prices.find((p) => p.location === code);
      if (loc?.price_per_tb_traffic?.net) {
        perTb = parseFloat(loc.price_per_tb_traffic.net);
        break;
      }
    }
    if (perTb == null) continue;

    out[canonical] = {
      free_gb_per_month: 0,
      bundled_with_compute: true,
      // Hetzner's "TB" is a TiB: included_traffic is an exact multiple of 1024^4.
      tiers: [{ up_to_gb: null, usd_per_gb: round(perTb / 1024, 8) }],
      notes: [
        `Overage is ${currency} ${perTb.toFixed(2)} per TiB, billed in 100 MB blocks.`,
        'Only outgoing traffic is billed; inbound and internal traffic are free.',
        'The bundled allowance is per plan and per location — see the compute table.',
      ],
    };
  }
  return Object.keys(out).length ? out : null;
}

/* --------------------------------------------------------------- driver -- */

export default async function collect() {
  const curated = JSON.parse(
    await readFile(resolve(ROOT, 'data/curated/egress.json'), 'utf8'),
  );
  const now = new Date().toISOString();
  const out = [];

  // One provider's endpoint failing must not zero the other eight (or the
  // curated entries, which need no network at all): on 2026-08-23 a single
  // Azure 429 emptied the entire dataset and tripped 71 regression errors.
  // The failed provider still publishes nothing, so the regression check
  // blocks the run for THAT provider — fail-closed is preserved, scoped.
  const live = {};
  const parts = {
    aws: awsSchedules,
    azure: azureSchedules,
    oci: ociSchedules,
    // Only supersedes the curated entry when a token is available.
    hetzner: hetznerSchedules,
  };
  for (const [provider, fn] of Object.entries(parts)) {
    try {
      const sched = await fn();
      if (sched) live[provider] = sched;
    } catch (err) {
      console.log(`  egress ${provider} part failed: ${err.message} — continuing without it`);
    }
  }

  for (const [provider, byRegion] of Object.entries(live)) {
    for (const [region, sched] of Object.entries(byRegion)) {
      out.push({
        provider,
        region,
        free_gb_per_month: sched.free_gb_per_month,
        bundled_with_compute: sched.bundled_with_compute,
        tiers: sched.tiers,
        currency: 'USD',
        source_url: PROVIDERS[provider].url,
        collected_at: now,
        source_verified_at: null,
        confidence: 'high',
        notes: sched.notes ?? [],
      });
    }
  }

  for (const [provider, sched] of Object.entries(curated)) {
    if (provider.startsWith('_')) continue;
    if (live[provider]) continue; // a live collector supersedes curated data

    for (const region of Object.keys(PROVIDERS[provider].regions)) {
      // Per-region overrides: GCP's top egress tier differs by destination
      // continent ($0.08 to North America, $0.085 to Europe), so a single
      // schedule per provider is not sufficient.
      const r = sched.regions?.[region] ?? {};
      out.push({
        provider,
        region,
        free_gb_per_month: r.free_gb_per_month ?? sched.free_gb_per_month ?? 0,
        bundled_with_compute: r.bundled_with_compute ?? sched.bundled_with_compute ?? false,
        tiers: r.tiers ?? sched.tiers,
        currency: 'USD',
        source_url: r.source_url ?? sched.source_url,
        collected_at: now,
        source_verified_at: r.source_verified_at ?? sched.source_verified_at ?? null,
        confidence: r.confidence ?? sched.confidence ?? 'medium',
        notes: [...(sched.notes ?? []), ...(r.notes ?? [])],
      });
    }
  }

  return out;
}
