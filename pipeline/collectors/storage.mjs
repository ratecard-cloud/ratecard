import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT, getJSON, saveRaw, storageRecord, PROVIDERS, round } from '../lib.mjs';
import { awsStorageHarvest } from './aws.mjs';

/**
 * Block storage: the general-purpose volume each provider actually sells,
 * normalised to $/GB-month. One product per provider — comparing a provider's
 * five volume classes against another's three is a different feature.
 *
 * The normalisation trap in this category: classic Azure managed disks price
 * by fixed size tier (P10, P20...), not per GB, so the honest per-GB comparable
 * is Premium SSD v2. AWS gp3 and SSD v2 both bundle a 3000 IOPS / 125 MB/s
 * baseline, which makes them directly comparable; others note their model.
 */

function aws() {
  const out = [];
  for (const [canonical, h] of Object.entries(awsStorageHarvest)) {
    out.push(
      storageRecord({
        provider: 'aws',
        region: canonical,
        region_code: h.code,
        sku: 'gp3',
        display_name: 'EBS gp3',
        usd_per_gb_month: h.price,
        min_size_gb: 1,
        max_size_gb: 16384,
        baseline_iops: 3000,
        baseline_throughput_mbps: 125,
        source_url: 'https://aws.amazon.com/ebs/pricing/',
        confidence: 'high',
        notes: ['3000 IOPS and 125 MB/s included; more is billed separately.'],
      }),
    );
  }
  // Harvested during the AWS compute pass; empty means that pass did not run.
  return out.length ? out : { skipped: 'aws compute pass did not run — gp3 rides its CSV stream' };
}

async function azure() {
  const out = [];
  const raw = {};
  for (const [canonical, code] of Object.entries(PROVIDERS.azure.regions)) {
    const filter =
      `serviceName eq 'Storage' and armRegionName eq '${code}' and ` +
      `productName eq 'Azure Premium SSD v2' and priceType eq 'Consumption'`;
    const body = await getJSON(
      `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}`,
    );
    const cap = body.Items.find(
      (i) => i.meterName === 'Premium LRS Provisioned Capacity' && i.unitOfMeasure === '1 GiB/Hour',
    );
    if (!cap) continue;
    raw[canonical] = cap;
    out.push(
      storageRecord({
        provider: 'azure',
        region: canonical,
        region_code: code,
        sku: 'premium-ssd-v2',
        display_name: 'Premium SSD v2',
        // Priced per GiB-hour; a 730-hour month matches the site convention.
        usd_per_gb_month: round(cap.retailPrice * 730, 6),
        min_size_gb: 1,
        max_size_gb: 65536,
        baseline_iops: 3000,
        baseline_throughput_mbps: 125,
        source_url: 'https://azure.microsoft.com/en-us/pricing/details/managed-disks/',
        confidence: 'high',
        notes: [
          'Priced per GiB-hour; shown as GiB x 730 hours.',
          '3000 IOPS and 125 MB/s included; more is billed separately.',
          'Classic managed disks (P-series) price by fixed size tier and are not per-GB comparable.',
        ],
      }),
    );
  }
  await saveRaw('azure', 'storage', raw);
  return out;
}

async function gcp() {
  const key = process.env.GCP_API_KEY;
  if (!key) return { skipped: 'GCP_API_KEY not set — see README "Credentials"' };

  const skus = [];
  let token = '';
  do {
    const url =
      `https://cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus` +
      `?key=${key}&pageSize=5000${token ? `&pageToken=${token}` : ''}`;
    const body = await getJSON(url);
    skus.push(...(body.skus ?? []));
    token = body.nextPageToken;
  } while (token);

  const relevant = skus.filter(
    (s) =>
      s.category?.resourceFamily === 'Storage' &&
      s.category?.usageType === 'OnDemand' &&
      /^Balanced PD Capacity/i.test(s.description),
  );
  await saveRaw('gcp', 'storage', relevant);

  const unitPrice = (sku) => {
    const rate = sku.pricingInfo?.[0]?.pricingExpression?.tieredRates?.at(-1)?.unitPrice;
    return rate ? Number(rate.units ?? 0) + (rate.nanos ?? 0) / 1e9 : null;
  };

  const out = [];
  for (const [canonical, code] of Object.entries(PROVIDERS.gcp.regions)) {
    const sku = relevant.find((s) => s.serviceRegions?.includes(code));
    const price = sku && unitPrice(sku);
    if (price == null) continue;
    out.push(
      storageRecord({
        provider: 'gcp',
        region: canonical,
        region_code: code,
        sku: 'pd-balanced',
        display_name: 'Balanced persistent disk',
        usd_per_gb_month: round(price, 6),
        min_size_gb: 10,
        max_size_gb: 65536,
        baseline_iops: null,
        baseline_throughput_mbps: null,
        source_url: 'https://cloud.google.com/compute/disks-image-pricing',
        confidence: 'high',
        notes: ['Performance scales with volume size (6 read IOPS per GB) rather than a flat baseline.'],
      }),
    );
  }
  return out;
}

async function oci() {
  // Storage plus enough VPUs for the "Balanced" profile (10 VPU/GB).
  const priceOf = async (part) => {
    const body = await getJSON(
      `https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?partNumber=${part}`,
    );
    const usd = body.items?.[0]?.currencyCodeLocalizations.find((c) => c.currencyCode === 'USD');
    const pay = usd?.prices.find((p) => p.model === 'PAY_AS_YOU_GO');
    if (!pay) throw new Error(`OCI part ${part}: no USD PAYG price`);
    return pay.value;
  };
  const storage = await priceOf('B91961');
  const vpu = await priceOf('B91962');
  await saveRaw('oci', 'storage', { B91961: storage, B91962: vpu });

  const perGb = round(storage + 10 * vpu, 6);
  return Object.entries(PROVIDERS.oci.regions).map(([canonical, code]) =>
    storageRecord({
      provider: 'oci',
      region: canonical,
      region_code: code,
      sku: 'block-volume-balanced',
      display_name: 'Block Volume (Balanced)',
      usd_per_gb_month: perGb,
      min_size_gb: 50,
      max_size_gb: 32768,
      baseline_iops: null,
      baseline_throughput_mbps: null,
      source_url: 'https://www.oracle.com/cloud/storage/pricing/',
      confidence: 'high',
      notes: [
        `Assembled: $${storage}/GB storage + 10 VPU x $${vpu} = $${perGb}/GB for the Balanced profile.`,
        'Performance scales with VPUs; Balanced is 60 IOPS/GB up to 25k.',
        'Uniform list price across commercial regions.',
      ],
    }),
  );
}

async function hetzner() {
  const token = process.env.HETZNER_API_TOKEN;
  if (!token) return { skipped: 'HETZNER_API_TOKEN not set — see README "Credentials"' };
  const body = await getJSON('https://api.hetzner.cloud/v1/pricing', {
    headers: { authorization: `Bearer ${token}` },
  });
  const perGb = parseFloat(body.pricing.volume.price_per_gb_month.net);
  await saveRaw('hetzner', 'storage', body.pricing.volume);

  return Object.entries(PROVIDERS.hetzner.regions).map(([canonical, code]) =>
    storageRecord({
      provider: 'hetzner',
      region: canonical,
      region_code: code,
      sku: 'volume',
      display_name: 'Volume',
      usd_per_gb_month: round(perGb, 6),
      min_size_gb: 10,
      max_size_gb: 10240,
      baseline_iops: null,
      baseline_throughput_mbps: null,
      source_url: 'https://www.hetzner.com/cloud/',
      confidence: 'high',
      notes: ['Single global price; net of VAT.'],
    }),
  );
}

async function linode() {
  const body = await getJSON('https://api.linode.com/v4/volumes/types');
  const t = body.data?.find((x) => x.id === 'volume');
  if (!t) throw new Error('linode volumes/types: "volume" type missing');
  await saveRaw('linode', 'storage', body);

  return Object.entries(PROVIDERS.linode.regions).map(([canonical, code]) => {
    const override = t.region_prices?.find((r) => r.id === code);
    return storageRecord({
      provider: 'linode',
      region: canonical,
      region_code: code,
      sku: 'linode-volume',
      display_name: 'Block Storage Volume',
      usd_per_gb_month: round(override?.monthly ?? t.price.monthly, 6),
      min_size_gb: 10,
      max_size_gb: 10240,
      baseline_iops: null,
      baseline_throughput_mbps: null,
      source_url: 'https://www.linode.com/pricing/',
      confidence: 'high',
      notes: ['NVMe-backed.'],
    });
  });
}

async function curated() {
  const file = JSON.parse(
    await readFile(resolve(ROOT, 'data/curated/storage.json'), 'utf8'),
  );
  const out = [];
  for (const [provider, c] of Object.entries(file)) {
    if (provider.startsWith('_')) continue;
    for (const [canonical, code] of Object.entries(PROVIDERS[provider].regions)) {
      out.push(
        storageRecord({
          provider,
          region: canonical,
          region_code: code,
          ...c,
        }),
      );
    }
  }
  return out;
}

export default async function collect() {
  const out = [];
  const statuses = {};
  const parts = { aws, azure, gcp, oci, hetzner, linode, curated };
  for (const [name, fn] of Object.entries(parts)) {
    try {
      const res = await fn();
      if (res && !Array.isArray(res) && res.skipped) {
        statuses[name] = { state: 'skipped', reason: res.skipped };
        continue;
      }
      out.push(...res);
      statuses[name] = { state: 'ok', records: res.length };
    } catch (err) {
      statuses[name] = { state: 'failed', error: String(err.message ?? err) };
    }
  }
  return { records: out, statuses };
}
