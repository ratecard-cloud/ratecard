import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import {
  ROOT, saveRaw, computeRecord, isTargetShape, monthlyFromHourly, PROVIDERS,
} from '../lib.mjs';

const SOURCE = 'https://aws.amazon.com/ec2/pricing/on-demand/';
const bulkURL = (region) =>
  `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/${region}/index.csv`;

/**
 * The bulk CSV is ~300 MB per region, so it is streamed line-by-line and never
 * held in memory. A local copy under data/cache/ is used when present.
 *
 * Upgrade path: the Price List Query API (GetProducts with filters) returns the
 * same data in kilobytes, but requires SigV4 credentials. The bulk file is used
 * here specifically so the pipeline runs with zero secrets.
 */
const FAMILIES = new Set([
  't3', 't4g',              // burstable
  'm7i', 'm7g', 'm7a',      // general purpose
  'c7i', 'c7g', 'c7a',      // compute optimised
  'r7i', 'r7g',             // memory optimised
]);

/** Minimal RFC4180-ish splitter — AWS quotes every field and embeds commas. */
function splitCSV(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function* rows(region) {
  const cached = resolve(ROOT, `data/cache/aws-ec2-${region}.csv`);
  const input = existsSync(cached)
    ? createReadStream(cached, 'utf8')
    : Readable.fromWeb((await fetch(bulkURL(region))).body);

  const rl = createInterface({ input, crlfDelay: Infinity });
  let header = null;
  let skipped = 0;
  for await (const line of rl) {
    if (!header) {
      // Five metadata lines precede the real header row.
      if (skipped < 5) { skipped++; continue; }
      header = splitCSV(line);
      continue;
    }
    const f = splitCSV(line);
    const rec = {};
    for (let i = 0; i < header.length; i++) rec[header[i]] = f[i];
    yield rec;
  }
}

/**
 * gp3 pricing harvested as a side-channel of the compute pass: the Storage rows
 * live in the same regional CSVs, and streaming ~300 MB x 4 a second time for
 * one number per region would double the CI bill. The storage collector reads
 * this after compute has run; in single-collector debug runs where AWS compute
 * did not run, it stays empty and the storage collector notes the skip.
 */
export const awsStorageHarvest = {};

export default async function collect() {
  const regions = PROVIDERS.aws.regions;
  const out = [];
  const raw = {};

  for (const [canonical, code] of Object.entries(regions)) {
    const found = {};
    for await (const r of rows(code)) {
      if (r.TermType !== 'OnDemand') continue;

      // Side-channel: one gp3 row per region, harvested in passing.
      if (
        r['Product Family'] === 'Storage' &&
        r['Volume API Name'] === 'gp3' &&
        r.Unit === 'GB-Mo'
      ) {
        const price = parseFloat(r.PricePerUnit);
        if (price > 0) awsStorageHarvest[canonical] = { code, price };
        continue;
      }

      if (r['Product Family'] !== 'Compute Instance') continue;
      if (r.Tenancy !== 'Shared') continue;
      if (r['Operating System'] !== 'Linux') continue;
      if (r['Pre Installed S/W'] && r['Pre Installed S/W'] !== 'NA') continue;
      if (r['License Model'] && r['License Model'] !== 'No License required') continue;
      if (r.CapacityStatus !== 'Used') continue;
      if (r.Unit !== 'Hrs') continue;

      const it = r['Instance Type'];
      const family = it?.split('.')[0];
      if (!family || !FAMILIES.has(family)) continue;

      const price = parseFloat(r.PricePerUnit);
      if (!(price > 0)) continue;

      const vcpu = parseInt(r.vCPU, 10);
      const ram_gb = parseFloat(String(r.Memory).replace(/[^\d.]/g, ''));
      if (!isTargetShape(vcpu, ram_gb)) continue;

      found[it] = { it, vcpu, ram_gb, price, phys: r['Physical Processor'], family };
    }
    raw[canonical] = found;

    for (const m of Object.values(found)) {
      // Graviton has no SMT: 1 vCPU is a full physical core. Intel/AMD vCPUs are threads.
      const isArm = /Graviton/i.test(m.phys ?? '');
      // Burstable families share a core and earn CPU credits — not a dedicated core.
      const burstable = m.family.startsWith('t');

      out.push(
        computeRecord({
          provider: 'aws',
          region: canonical,
          region_code: code,
          sku: m.it,
          display_name: m.it,
          vcpu: m.vcpu,
          vcpu_type: burstable ? 'shared' : 'dedicated',
          vcpu_unit: isArm ? 'core' : 'thread',
          ram_gb: m.ram_gb,
          arch: isArm ? 'arm64' : 'x86_64',
          local_storage_gb: 0,
          included_egress_gb: 0, // AWS's 100 GB free tier is account-wide → egress.json
          price_hourly_usd: m.price,
          price_monthly_usd: monthlyFromHourly(m.price),
          source_url: SOURCE,
          confidence: 'high',
          notes: [
            `${m.phys}.`,
            burstable
              ? 'Burstable: sustained full-CPU use requires CPU credits and can cost more.'
              : '',
            'EBS root volume and egress billed separately.',
          ].filter(Boolean),
        }),
      );
    }
  }

  await saveRaw('aws', 'compute', raw);
  return out;
}
