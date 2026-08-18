import { getJSON, saveRaw, computeRecord, isTargetShape, PROVIDERS } from '../lib.mjs';

const SOURCE = 'https://www.digitalocean.com/pricing/droplets';
const API = 'https://api.digitalocean.com/v2/sizes?per_page=500';

/** Requires DO_API_TOKEN — a free read-only PAT from the DigitalOcean console. */
export default async function collect() {
  const token = process.env.DO_API_TOKEN;
  if (!token) {
    return { skipped: 'DO_API_TOKEN not set — see README "Credentials"' };
  }
  const regions = PROVIDERS.digitalocean.regions;
  const raw = await getJSON(API, { headers: { authorization: `Bearer ${token}` } });
  await saveRaw('digitalocean', 'compute', raw);

  const out = [];
  for (const s of raw.sizes) {
    if (!s.available) continue;
    const ram_gb = s.memory / 1024;
    if (!isTargetShape(s.vcpus, ram_gb)) continue;

    // Slug prefixes: s-* shared "Basic"; c-*/g-*/m-* dedicated CPU tiers.
    const shared = s.slug.startsWith('s-');

    for (const [canonical, code] of Object.entries(regions)) {
      if (!s.regions.includes(code)) continue;
      out.push(
        computeRecord({
          provider: 'digitalocean',
          region: canonical,
          region_code: code,
          sku: s.slug,
          display_name: s.description ?? s.slug,
          vcpu: s.vcpus,
          vcpu_type: shared ? 'shared' : 'dedicated',
          vcpu_unit: shared ? 'thread' : 'core',
          ram_gb,
          arch: 'x86_64',
          local_storage_gb: s.disk,
          included_egress_gb: (s.transfer ?? 0) * 1024, // API reports TB
          price_hourly_usd: s.price_hourly,
          price_monthly_usd: s.price_monthly,
          source_url: SOURCE,
          confidence: 'high',
          notes: [
            `Includes ${s.transfer} TB outbound transfer per month.`,
            'Transfer allowance is pooled across all Droplets on the account.',
            // DO computes hourly as monthly/672 (28-day month), so hourly*730
            // overshoots monthly by ~9%. The word "cap" also tells the
            // validator this gap is explained, silencing ~30 warnings a run.
            'Monthly price is a billing cap: hourly billing stops accruing at 672 hours.',
          ],
        }),
      );
    }
  }
  return out;
}
