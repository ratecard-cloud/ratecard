import compute from '../../data/normalized/compute.json';
import egress from '../../data/normalized/egress.json';
import manifest from '../../data/normalized/manifest.json';
import providers from '../../data/providers.json';
import regions from '../../data/regions.json';

export interface ComputeRow {
  provider: string;
  region: string;
  region_code: string | null;
  sku: string;
  display_name: string;
  vcpu: number;
  vcpu_type: 'shared' | 'dedicated';
  vcpu_unit: 'thread' | 'core';
  ram_gb: number;
  arch: string;
  local_storage_gb: number;
  included_egress_gb: number;
  price_hourly_usd: number;
  price_monthly_usd: number;
  currency: string;
  source_url: string;
  collected_at: string;
  source_verified_at: string | null;
  confidence: 'high' | 'medium' | 'low';
  notes: string[];
}

export interface EgressTier { up_to_gb: number | null; usd_per_gb: number }
export interface EgressRow {
  provider: string;
  region: string;
  free_gb_per_month: number;
  bundled_with_compute: boolean;
  tiers: EgressTier[];
  source_url: string;
  collected_at: string;
  source_verified_at: string | null;
  confidence: 'high' | 'medium' | 'low';
  notes: string[];
}

export interface Provider {
  name: string; short: string; tier: number; url: string;
  affiliate: string | null; collector: string;
  regions: Record<string, string>;
}

export const COMPUTE = compute as ComputeRow[];
export const EGRESS = egress as EgressRow[];
export const MANIFEST = manifest as {
  generated_at: string;
  compute_records: number;
  providers: Record<string, { state: string; records?: number; reason?: string; error?: string }>;
};
export const PROVIDERS = providers as unknown as Record<string, Provider>;
export const REGIONS = regions as Record<string, { label: string; blurb: string; default: boolean }>;

/** Providers that actually have data right now, in display order. */
export const ACTIVE_PROVIDERS = [...new Set(COMPUTE.map((r) => r.provider))].sort(
  (a, b) => PROVIDERS[a].tier - PROVIDERS[b].tier || a.localeCompare(b),
);

export const SHAPES = [...new Set(COMPUTE.map((r) => `${r.vcpu}/${r.ram_gb}`))]
  .map((s) => {
    const [vcpu, ram_gb] = s.split('/').map(Number);
    return { vcpu, ram_gb, key: s, label: `${vcpu} vCPU / ${ram_gb} GB` };
  })
  .sort((a, b) => a.vcpu - b.vcpu || a.ram_gb - b.ram_gb);

export function egressSchedule(provider: string, region: string) {
  return EGRESS.find((e) => e.provider === provider && e.region === region);
}

/** Cost of `gb` outbound under a tiered schedule, after the free allowance. */
export function egressCost(sched: EgressRow | undefined, gb: number): number {
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
 */
export function effectiveMonthly(row: ComputeRow, egressGb: number) {
  const billable = Math.max(0, egressGb - (row.included_egress_gb ?? 0));
  const egressUsd = egressCost(egressSchedule(row.provider, row.region), billable);
  return {
    base: row.price_monthly_usd,
    egress: egressUsd,
    total: Math.round((row.price_monthly_usd + egressUsd) * 100) / 100,
  };
}

export const usd = (n: number) =>
  n >= 1000
    ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    : `$${n.toFixed(2)}`;

export const gbLabel = (gb: number) =>
  gb === 0 ? '0' : gb >= 1024 ? `${+(gb / 1024).toFixed(gb % 1024 ? 1 : 0)} TB` : `${gb} GB`;

export function freshness(iso: string) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}
