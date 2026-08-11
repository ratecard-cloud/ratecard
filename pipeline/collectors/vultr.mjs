import { getJSON, saveRaw, computeRecord, isTargetShape, PROVIDERS } from '../lib.mjs';

const SOURCE = 'https://www.vultr.com/pricing/';
const API = 'https://api.vultr.com/v2/plans?per_page=500';

// vc2 = shared vCPU, vhf/vhp = high-frequency shared, voc* = dedicated ("optimized cloud").
const TYPE_MAP = {
  vc2: { vcpu_type: 'shared', label: 'Regular Cloud Compute' },
  vhf: { vcpu_type: 'shared', label: 'High Frequency' },
  vhp: { vcpu_type: 'shared', label: 'High Performance' },
  vdc: { vcpu_type: 'dedicated', label: 'Dedicated Cloud' },
  voc: { vcpu_type: 'dedicated', label: 'Optimized Cloud' },
};

export default async function collect() {
  const regions = PROVIDERS.vultr.regions;
  const raw = await getJSON(API);
  await saveRaw('vultr', 'compute', raw);

  const out = [];
  for (const p of raw.plans) {
    const family = TYPE_MAP[p.type] ?? TYPE_MAP[p.type?.split('-')[0]];
    if (!family) continue;
    if (p.gpu_brand && p.gpu_brand !== 'none') continue;
    if (p.monthly_cost <= 0) continue;

    const ram_gb = p.ram / 1024;
    if (!isTargetShape(p.vcpu_count, ram_gb)) continue;

    for (const [canonical, code] of Object.entries(regions)) {
      if (!p.locations.includes(code)) continue;
      // location_cost carries per-region overrides where they exist.
      const override = p.location_cost?.[code];
      const monthly = override?.monthly_cost ?? p.monthly_cost;
      const hourly = override?.hourly_cost ?? p.hourly_cost;

      out.push(
        computeRecord({
          provider: 'vultr',
          region: canonical,
          region_code: code,
          sku: p.id,
          display_name: `${family.label} ${p.vcpu_count}C/${ram_gb}GB`,
          vcpu: p.vcpu_count,
          vcpu_type: family.vcpu_type,
          // Vultr reports this itself — one of the few providers that does.
          vcpu_unit: p.vcpu_type === 'thread' ? 'thread' : 'core',
          ram_gb,
          arch: 'x86_64',
          local_storage_gb: p.disk * (p.disk_count || 1),
          included_egress_gb: p.bandwidth,
          price_hourly_usd: hourly,
          price_monthly_usd: monthly,
          source_url: SOURCE,
          confidence: 'high',
          notes: [`${p.cpu_vendor} CPU, ${p.storage_type.replace('_', ' ')}.`],
        }),
      );
    }
  }
  return out;
}
