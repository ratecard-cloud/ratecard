import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOURS_PER_MONTH = 730;

export const PROVIDERS = JSON.parse(
  await readFile(resolve(ROOT, 'data/providers.json'), 'utf8'),
);

/** Fetch JSON with a timeout and an honest UA. Throws on non-2xx. */
export async function getJSON(url, { headers = {}, timeout = 60_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'user-agent': 'RateCard/0.1 (+https://ratecard.cloud; pricing index bot)',
        accept: 'application/json',
        ...headers,
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Persist the raw upstream payload next to the normalized output.
 * Lets us re-derive when the normalizer changes without re-hitting provider APIs.
 */
export async function saveRaw(provider, category, payload) {
  if (process.env.RC_NO_WRITE) return; // tests replay collectors; nothing may touch disk
  const path = resolve(ROOT, `data/raw/${provider}/${category}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 1) + '\n');
}

export async function saveNormalized(category, records) {
  if (process.env.RC_NO_WRITE) return records.length;
  // Stable sort so git diffs show real price changes, not row reshuffling.
  records.sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      a.region.localeCompare(b.region) ||
      (a.vcpu ?? 0) - (b.vcpu ?? 0) ||
      (a.ram_gb ?? 0) - (b.ram_gb ?? 0) ||
      String(a.sku).localeCompare(String(b.sku)),
  );
  const path = resolve(ROOT, `data/normalized/${category}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(records, null, 1) + '\n');
  return records.length;
}

export async function loadNormalized(category) {
  return JSON.parse(
    await readFile(resolve(ROOT, `data/normalized/${category}.json`), 'utf8'),
  );
}

export const round = (n, dp = 4) =>
  n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp;

export const monthlyFromHourly = (h) => round(h * HOURS_PER_MONTH, 2);
export const hourlyFromMonthly = (m) => round(m / HOURS_PER_MONTH, 6);

/**
 * Which machine sizes we surface. Keeping the grid to a handful of canonical
 * shapes is what makes cross-provider comparison meaningful at all.
 */
export const TARGET_SHAPES = [
  { vcpu: 2, ram_gb: 4 },
  { vcpu: 2, ram_gb: 8 },
  { vcpu: 4, ram_gb: 8 },
  { vcpu: 4, ram_gb: 16 },
  { vcpu: 8, ram_gb: 16 },
  { vcpu: 8, ram_gb: 32 },
  { vcpu: 16, ram_gb: 32 },
  { vcpu: 16, ram_gb: 64 },
];

export const isTargetShape = (vcpu, ram_gb) =>
  TARGET_SHAPES.some((s) => s.vcpu === vcpu && Math.abs(s.ram_gb - ram_gb) < 0.51);

export function computeRecord(o) {
  const required = [
    'provider', 'region', 'sku', 'vcpu', 'vcpu_type',
    'vcpu_unit', 'ram_gb', 'arch', 'source_url', 'confidence',
  ];
  for (const k of required) {
    if (o[k] === undefined || o[k] === null) {
      throw new Error(`compute record missing "${k}": ${JSON.stringify(o).slice(0, 200)}`);
    }
  }
  if (!['shared', 'dedicated'].includes(o.vcpu_type)) {
    throw new Error(`bad vcpu_type "${o.vcpu_type}" for ${o.provider}/${o.sku}`);
  }
  if (!['thread', 'core'].includes(o.vcpu_unit)) {
    throw new Error(`bad vcpu_unit "${o.vcpu_unit}" for ${o.provider}/${o.sku}`);
  }
  return {
    provider: o.provider,
    region: o.region,
    region_code: o.region_code ?? null,
    sku: o.sku,
    display_name: o.display_name ?? o.sku,
    vcpu: o.vcpu,
    vcpu_type: o.vcpu_type,
    vcpu_unit: o.vcpu_unit,
    ram_gb: round(o.ram_gb, 2),
    arch: o.arch,
    local_storage_gb: o.local_storage_gb ?? 0,
    included_egress_gb: o.included_egress_gb ?? 0,
    price_hourly_usd: round(o.price_hourly_usd, 6),
    price_monthly_usd: round(o.price_monthly_usd, 2),
    currency: 'USD',
    source_url: o.source_url,
    collected_at: o.collected_at ?? new Date().toISOString(),
    source_verified_at: o.source_verified_at ?? null,
    confidence: o.confidence,
    notes: o.notes ?? [],
  };
}

/** Cost of `gb` outbound under a tiered schedule, after the free allowance. */
export function egressCost(schedule, gb) {
  if (!schedule) return null;
  let remaining = Math.max(0, gb - (schedule.free_gb_per_month ?? 0));
  let cost = 0;
  let floor = 0;
  for (const tier of schedule.tiers) {
    if (remaining <= 0) break;
    const span = tier.up_to_gb == null ? Infinity : tier.up_to_gb - floor;
    const used = Math.min(remaining, span);
    cost += used * tier.usd_per_gb;
    remaining -= used;
    floor = tier.up_to_gb ?? floor;
  }
  return round(cost, 2);
}
