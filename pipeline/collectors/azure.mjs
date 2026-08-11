import { getJSON, saveRaw, computeRecord, monthlyFromHourly, PROVIDERS } from '../lib.mjs';

const SOURCE =
  'https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/';
const API = 'https://prices.azure.com/api/retail/prices';

/**
 * Azure's API exposes no vCPU/RAM metadata — only SKU names and prices. Specs come
 * from the published VM series docs, so the SKU list is curated and the *prices*
 * are live. Dsv5/Dasv5 are hyperthreaded x86; Dpsv5 is Ampere Altra (1 vCPU = 1 core).
 */
const SKUS = {
  Standard_D2s_v5:  { vcpu: 2,  ram_gb: 8,  arch: 'x86_64', unit: 'thread' },
  Standard_D4s_v5:  { vcpu: 4,  ram_gb: 16, arch: 'x86_64', unit: 'thread' },
  Standard_D8s_v5:  { vcpu: 8,  ram_gb: 32, arch: 'x86_64', unit: 'thread' },
  Standard_D16s_v5: { vcpu: 16, ram_gb: 64, arch: 'x86_64', unit: 'thread' },
  Standard_F2s_v2:  { vcpu: 2,  ram_gb: 4,  arch: 'x86_64', unit: 'thread' },
  Standard_F4s_v2:  { vcpu: 4,  ram_gb: 8,  arch: 'x86_64', unit: 'thread' },
  Standard_F8s_v2:  { vcpu: 8,  ram_gb: 16, arch: 'x86_64', unit: 'thread' },
  Standard_F16s_v2: { vcpu: 16, ram_gb: 32, arch: 'x86_64', unit: 'thread' },
  Standard_D2ps_v5: { vcpu: 2,  ram_gb: 8,  arch: 'arm64',  unit: 'core' },
  Standard_D4ps_v5: { vcpu: 4,  ram_gb: 16, arch: 'arm64',  unit: 'core' },
  Standard_D8ps_v5: { vcpu: 8,  ram_gb: 32, arch: 'arm64',  unit: 'core' },
};

const isLinuxOnDemand = (item) =>
  !/Windows/i.test(item.productName) &&
  !/Spot|Low Priority/i.test(item.skuName) &&
  item.type === 'Consumption' &&
  item.unitOfMeasure === '1 Hour';

export default async function collect() {
  const regions = PROVIDERS.azure.regions;
  const out = [];
  const rawAll = {};

  for (const [canonical, code] of Object.entries(regions)) {
    const filter = [
      `serviceName eq 'Virtual Machines'`,
      `armRegionName eq '${code}'`,
      `priceType eq 'Consumption'`,
    ].join(' and ');

    // Page through; the API caps at 1000 items per response.
    let url = `${API}?$filter=${encodeURIComponent(filter)}`;
    const items = [];
    for (let page = 0; url && page < 20; page++) {
      const body = await getJSON(url);
      items.push(...body.Items);
      url = body.NextPageLink;
    }

    // Persist only the SKUs we actually index. The full region response is ~9k
    // items (~6 MB); committing that daily would add gigabytes of git history a
    // year for data we never read. Raw is kept in proportion to how expensive it
    // is to re-fetch, and this endpoint is free, unauthenticated and ~6s.
    const kept = [];
    rawAll[canonical] = kept;

    for (const [sku, spec] of Object.entries(SKUS)) {
      const match = items.find((i) => i.armSkuName === sku && isLinuxOnDemand(i));
      if (!match) continue;
      kept.push(match);

      out.push(
        computeRecord({
          provider: 'azure',
          region: canonical,
          region_code: code,
          sku,
          display_name: sku.replace('Standard_', ''),
          vcpu: spec.vcpu,
          vcpu_type: 'dedicated',
          vcpu_unit: spec.unit,
          ram_gb: spec.ram_gb,
          arch: spec.arch,
          local_storage_gb: 0,
          included_egress_gb: 0,
          price_hourly_usd: match.retailPrice,
          price_monthly_usd: monthlyFromHourly(match.retailPrice),
          source_url: SOURCE,
          confidence: 'high',
          notes: [
            'Linux, pay-as-you-go, no OS licence. OS disk billed separately.',
            'Egress billed separately — first 100 GB/month free account-wide.',
          ],
        }),
      );
    }
  }

  await saveRaw('azure', 'compute', rawAll);
  return out;
}
