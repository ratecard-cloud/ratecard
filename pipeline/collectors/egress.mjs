import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { ROOT, getJSON, saveRaw, PROVIDERS, round } from '../lib.mjs';

/* ------------------------------------------------------------------ AWS -- */

const AWS_DT_URL =
  'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/index.csv';

const AWS_FROM = { 'us-east': 'US East (N. Virginia)', 'eu-central': 'EU (Frankfurt)' };

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

/* --------------------------------------------------------------- driver -- */

export default async function collect() {
  const curated = JSON.parse(
    await readFile(resolve(ROOT, 'data/curated/egress.json'), 'utf8'),
  );
  const now = new Date().toISOString();
  const out = [];

  const live = {
    aws: await awsSchedules(),
    azure: await azureSchedules(),
  };

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
    for (const region of Object.keys(PROVIDERS[provider].regions)) {
      out.push({
        provider,
        region,
        free_gb_per_month: sched.free_gb_per_month ?? 0,
        bundled_with_compute: sched.bundled_with_compute ?? false,
        tiers: sched.tiers,
        currency: 'USD',
        source_url: sched.source_url,
        collected_at: now,
        source_verified_at: null,
        confidence: sched.confidence ?? 'medium',
        notes: sched.notes ?? [],
      });
    }
  }

  return out;
}
