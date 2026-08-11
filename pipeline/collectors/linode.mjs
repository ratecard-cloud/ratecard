import {
  getJSON, saveRaw, computeRecord, isTargetShape, PROVIDERS, round, HOURS_PER_MONTH,
} from '../lib.mjs';

const SOURCE = 'https://www.linode.com/pricing/';
const API = 'https://api.linode.com/v4/linode/types';

const CLASS_MAP = {
  nanode: { vcpu_type: 'shared', label: 'Nanode' },
  standard: { vcpu_type: 'shared', label: 'Shared' },
  dedicated: { vcpu_type: 'dedicated', label: 'Dedicated' },
  highmem: { vcpu_type: 'dedicated', label: 'High Memory' },
  premium: { vcpu_type: 'dedicated', label: 'Premium' },
};

export default async function collect() {
  const regions = PROVIDERS.linode.regions;
  const raw = await getJSON(API);
  await saveRaw('linode', 'compute', raw);

  const out = [];
  for (const t of raw.data) {
    const cls = CLASS_MAP[t.class];
    if (!cls) continue; // skips gpu / accelerated

    const ram_gb = t.memory / 1024;
    if (!isTargetShape(t.vcpus, ram_gb)) continue;

    for (const [canonical, code] of Object.entries(regions)) {
      // region_prices only lists *exceptions*; absence means the base price applies.
      const override = t.region_prices?.find((r) => r.id === code);
      const hourly = override?.hourly ?? t.price.hourly;
      // The g8 generation is billed hourly with no monthly cap (monthly: null).
      const quotedMonthly = override?.monthly ?? t.price.monthly;
      const monthly = quotedMonthly ?? round(hourly * HOURS_PER_MONTH, 2);

      // Where Linode does quote a monthly price it is a *cap*: sustained use is
      // billed hourly until it reaches this ceiling, so monthly < hourly * 730.
      const capped = quotedMonthly != null && quotedMonthly < hourly * HOURS_PER_MONTH * 0.98;

      out.push(
        computeRecord({
          provider: 'linode',
          region: canonical,
          region_code: code,
          sku: t.id,
          display_name: `${cls.label} ${t.label}`,
          vcpu: t.vcpus,
          vcpu_type: cls.vcpu_type,
          vcpu_unit: 'thread',
          ram_gb,
          arch: 'x86_64',
          local_storage_gb: Math.round(t.disk / 1024),
          included_egress_gb: t.transfer, // already GB
          price_hourly_usd: hourly,
          price_monthly_usd: monthly,
          source_url: SOURCE,
          confidence: 'high',
          notes: [
            t.transfer > 0
              ? `Includes ${t.transfer} GB outbound transfer per month.`
              : 'No bundled transfer — this generation unbundles network transfer, billed separately per GB.',
            capped
              ? 'Monthly price is a billing cap — hourly usage stops accruing once reached, so it is cheaper than hourly x 730.'
              : '',
            quotedMonthly == null
              ? 'Billed hourly with no monthly cap; monthly figure is hourly x 730.'
              : '',
          ].filter(Boolean),
        }),
      );
    }
  }
  return out;
}
