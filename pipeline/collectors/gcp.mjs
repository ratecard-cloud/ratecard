import { getJSON, saveRaw, computeRecord, monthlyFromHourly, PROVIDERS } from '../lib.mjs';

const SOURCE = 'https://cloud.google.com/compute/vm-instance-pricing';
const COMPUTE_SERVICE = '6F81-5844-456A'; // Compute Engine
const API = 'https://cloudbilling.googleapis.com/v1';

/**
 * Requires GCP_API_KEY — a free, unrestricted-read API key with the Cloud Billing
 * API enabled.
 *
 * GCP is the hardest provider to normalise: it does not price machine types at
 * all. It prices "N2 Instance Core running in Americas" and "N2 Instance Ram
 * running in Americas" as separate SKUs, so an instance price has to be
 * reassembled from components. Any site claiming a GCP "instance price" is doing
 * this arithmetic — we do it explicitly and show our work.
 */
const MACHINE_FAMILIES = {
  n2: { core: /^N2 Instance Core running/i, ram: /^N2 Instance Ram running/i, arch: 'x86_64', unit: 'thread' },
  n2d: { core: /^N2D AMD Instance Core running/i, ram: /^N2D AMD Instance Ram running/i, arch: 'x86_64', unit: 'thread' },
  t2a: { core: /^T2A Arm Instance Core running/i, ram: /^T2A Arm Instance Ram running/i, arch: 'arm64', unit: 'core' },
};

const SHAPES = [
  { vcpu: 2, ram_gb: 8 }, { vcpu: 4, ram_gb: 16 },
  { vcpu: 8, ram_gb: 32 }, { vcpu: 16, ram_gb: 64 },
];

const unitPrice = (sku) => {
  const rate = sku.pricingInfo?.[0]?.pricingExpression?.tieredRates?.at(-1)?.unitPrice;
  if (!rate) return null;
  return Number(rate.units ?? 0) + (rate.nanos ?? 0) / 1e9;
};

export default async function collect() {
  const key = process.env.GCP_API_KEY;
  if (!key) return { skipped: 'GCP_API_KEY not set — see README "Credentials"' };

  const skus = [];
  let token = '';
  do {
    const url = `${API}/services/${COMPUTE_SERVICE}/skus?key=${key}&pageSize=5000${token ? `&pageToken=${token}` : ''}`;
    const body = await getJSON(url);
    skus.push(...(body.skus ?? []));
    token = body.nextPageToken;
  } while (token);

  const regions = PROVIDERS.gcp.regions;
  const relevant = skus.filter(
    (s) =>
      s.category?.resourceFamily === 'Compute' &&
      s.category?.usageType === 'OnDemand' &&
      Object.values(MACHINE_FAMILIES).some(
        (f) => f.core.test(s.description) || f.ram.test(s.description),
      ),
  );
  await saveRaw('gcp', 'compute', relevant);

  const out = [];
  for (const [canonical, code] of Object.entries(regions)) {
    for (const [family, f] of Object.entries(MACHINE_FAMILIES)) {
      const inRegion = (s) => s.serviceRegions?.includes(code);
      const coreSku = relevant.find((s) => f.core.test(s.description) && inRegion(s));
      const ramSku = relevant.find((s) => f.ram.test(s.description) && inRegion(s));
      if (!coreSku || !ramSku) continue;

      const perCore = unitPrice(coreSku);
      const perGB = unitPrice(ramSku);
      if (perCore == null || perGB == null) continue;

      for (const shape of SHAPES) {
        const hourly = shape.vcpu * perCore + shape.ram_gb * perGB;
        out.push(
          computeRecord({
            provider: 'gcp',
            region: canonical,
            region_code: code,
            sku: `${family}-standard-${shape.vcpu}`,
            display_name: `${family}-standard-${shape.vcpu}`,
            vcpu: shape.vcpu,
            vcpu_type: 'dedicated',
            vcpu_unit: f.unit,
            ram_gb: shape.ram_gb,
            arch: f.arch,
            local_storage_gb: 0,
            included_egress_gb: 0,
            price_hourly_usd: hourly,
            price_monthly_usd: monthlyFromHourly(hourly),
            source_url: SOURCE,
            confidence: 'medium', // reassembled from component SKUs, not a quoted price
            notes: [
              `Reassembled from component SKUs: ${shape.vcpu} vCPU x $${perCore.toFixed(6)}/hr + ${shape.ram_gb} GB x $${perGB.toFixed(6)}/hr.`,
              'GCP does not publish a single per-machine-type price; this is the sum of its parts.',
              'Excludes sustained-use discounts, which apply automatically on real bills.',
              'Boot disk and egress billed separately.',
            ],
          }),
        );
      }
    }
  }
  return out;
}
