import { getJSON, saveRaw, computeRecord, isTargetShape, PROVIDERS } from '../lib.mjs';
import { toUSD, fxNote } from '../fx.mjs';

const SOURCE = 'https://www.hetzner.com/cloud/';
const API = 'https://api.hetzner.cloud/v1';

/**
 * Requires HETZNER_API_TOKEN — a free read-only token from any Hetzner Cloud
 * project (Security → API tokens). Without it this collector is skipped, rather
 * than falling back to guessed numbers.
 *
 * Hetzner is the strongest argument for the whole site: CX/CAX/CPX plans bundle
 * ~20 TB of egress where AWS bundles 100 GB. Sorted on raw $/month Hetzner looks
 * merely cheap; sorted on egress-inclusive cost it is often an order of magnitude
 * cheaper.
 */
const CPU_TYPE = { shared: 'shared', dedicated: 'dedicated' };

export default async function collect() {
  const token = process.env.HETZNER_API_TOKEN;
  if (!token) {
    return { skipped: 'HETZNER_API_TOKEN not set — see README "Credentials"' };
  }
  const headers = { authorization: `Bearer ${token}` };
  const regions = PROVIDERS.hetzner.regions;

  const [types, pricing] = await Promise.all([
    getJSON(`${API}/server_types?per_page=100`, { headers }),
    getJSON(`${API}/pricing`, { headers }),
  ]);
  await saveRaw('hetzner', 'compute', { server_types: types, pricing });

  const currency = pricing.pricing.currency ?? 'EUR';
  const note = await fxNote(currency);
  const priceByType = new Map(
    pricing.pricing.server_types.map((s) => [s.id, s.prices]),
  );

  const out = [];
  for (const t of types.server_types) {
    if (t.deprecated) continue;
    const ram_gb = t.memory;
    if (!isTargetShape(t.cores, ram_gb)) continue;

    const prices = priceByType.get(t.id);
    if (!prices) continue;

    for (const [canonical, code] of Object.entries(regions)) {
      const loc = prices.find((p) => p.location === code);
      if (!loc) continue;

      // Hetzner quotes net (ex-VAT) and gross; list-price comparisons use net.
      const monthlyNative = parseFloat(loc.price_monthly.net);
      const hourlyNative = parseFloat(loc.price_hourly.net);

      out.push(
        computeRecord({
          provider: 'hetzner',
          region: canonical,
          region_code: code,
          sku: t.name,
          display_name: t.name.toUpperCase(),
          vcpu: t.cores,
          vcpu_type: CPU_TYPE[t.cpu_type] ?? 'shared',
          // Hetzner "cores" are physical cores on dedicated (CCX) plans and
          // vCPU slices on shared (CX/CPX/CAX) plans.
          vcpu_unit: t.cpu_type === 'dedicated' ? 'core' : 'thread',
          ram_gb,
          arch: t.architecture === 'arm' ? 'arm64' : 'x86_64',
          local_storage_gb: t.disk,
          // included_traffic lives on the per-LOCATION price entry, not on the
          // server type. Reading it off the type yields undefined -> 0, which
          // silently strips Hetzner's whole advantage: EU locations bundle
          // ~20 TiB while US locations bundle only 1-8 TiB.
          included_egress_gb: Math.round((loc.included_traffic ?? 0) / 1024 ** 3),
          price_hourly_usd: await toUSD(hourlyNative, currency),
          price_monthly_usd: await toUSD(monthlyNative, currency),
          source_url: SOURCE,
          confidence: 'high',
          notes: [
            t.description,
            note,
            'Prices are net of VAT.',
            `Bundled traffic differs sharply by location: this one includes ${Math.round((loc.included_traffic ?? 0) / 1024 ** 4)} TiB/month.`,
            `Overage $${parseFloat(loc.price_per_tb_traffic.net).toFixed(2)} per TiB.`,
          ].filter(Boolean),
        }),
      );
    }
  }
  return out;
}
