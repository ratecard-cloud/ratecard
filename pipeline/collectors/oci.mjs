import {
  getJSON, saveRaw, computeRecord, monthlyFromHourly, PROVIDERS, TARGET_SHAPES,
} from '../lib.mjs';

const SOURCE = 'https://www.oracle.com/cloud/price-list/';
const API = 'https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/';

/**
 * OCI prices flex shapes per-OCPU-hour plus per-GB-hour, so an instance price is
 * assembled rather than looked up. There is no list endpoint on this API — part
 * numbers must be found by hand on the price list page, hence the hardcoded map.
 *
 * An OCPU is a full physical core (2 hardware threads), NOT a vCPU. We record
 * vcpu = ocpu * 2 with vcpu_unit 'thread' so the comparison against AWS/Azure
 * hyperthreaded vCPUs is apples-to-apples.
 *
 * TODO: Ampere A1 (arm64) part numbers are not discoverable through this API.
 * Needs a manual lookup before ARM coverage can be claimed for OCI.
 */
const SHAPES = {
  'VM.Standard.E4.Flex': {
    ocpu_part: 'B93113',
    mem_part: 'B93114',
    arch: 'x86_64',
    vcpu_unit: 'thread',
  },
};

// OCI list pricing is uniform across commercial regions.
const REGION_UNIFORM = true;

async function priceUSD(partNumber) {
  const body = await getJSON(`${API}?partNumber=${partNumber}`);
  const item = body.items?.[0];
  if (!item) throw new Error(`OCI part ${partNumber} not found`);
  const usd = item.currencyCodeLocalizations.find((c) => c.currencyCode === 'USD');
  const pay = usd?.prices.find((p) => p.model === 'PAY_AS_YOU_GO');
  if (!pay) throw new Error(`OCI part ${partNumber} has no USD PAYG price`);
  return { price: pay.value, item };
}

export default async function collect() {
  const regions = PROVIDERS.oci.regions;
  const out = [];
  const raw = {};

  for (const [shapeName, shape] of Object.entries(SHAPES)) {
    const ocpu = await priceUSD(shape.ocpu_part);
    const mem = await priceUSD(shape.mem_part);
    raw[shapeName] = { ocpu: ocpu.item, memory: mem.item };

    // Flex shapes let you pick OCPU and memory independently, so we build them
    // to hit the comparison grid exactly rather than at OCI's default ratio.
    // Anything else would leave OCI absent from every shape-matched row.
    for (const target of TARGET_SHAPES) {
      const vcpu = target.vcpu;
      const ram_gb = target.ram_gb;
      const n = vcpu / 2; // OCPU = 1 physical core = 2 vCPU
      if (!Number.isInteger(n) || n < 1) continue;
      const hourly = n * ocpu.price + ram_gb * mem.price;

      for (const [canonical, code] of Object.entries(regions)) {
        out.push(
          computeRecord({
            provider: 'oci',
            region: canonical,
            region_code: code,
            sku: `${shapeName}-${n}ocpu-${ram_gb}gb`,
            display_name: `E4.Flex ${n} OCPU / ${ram_gb} GB`,
            vcpu,
            vcpu_type: 'dedicated',
            vcpu_unit: shape.vcpu_unit,
            ram_gb,
            arch: shape.arch,
            local_storage_gb: 0,
            // OCI's 10 TB/month free egress is account-wide, not per instance —
            // it belongs in egress.json's free_gb_per_month, or it double-counts.
            included_egress_gb: 0,
            price_hourly_usd: hourly,
            price_monthly_usd: monthlyFromHourly(hourly),
            source_url: SOURCE,
            confidence: 'high',
            notes: [
              `Flex shape: ${n} OCPU (= ${vcpu} vCPU) + ${ram_gb} GB, priced per component.`,
              'First 10 TB/month outbound is free, account-wide (not per instance).',
              REGION_UNIFORM ? 'OCI list pricing is uniform across commercial regions.' : '',
            ].filter(Boolean),
          }),
        );
      }
    }
  }

  await saveRaw('oci', 'compute', raw);
  return out;
}
