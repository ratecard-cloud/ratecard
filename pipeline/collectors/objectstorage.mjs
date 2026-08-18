import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT, getJSON, saveRaw, PROVIDERS, round } from '../lib.mjs';

/**
 * Object storage, standard/hot tier. Two pricing models coexist and the
 * schema keeps them distinct rather than flattening:
 *
 *   per-gb        pay for what you store (S3, Blob, GCS, OCI, R2, B2, Vultr)
 *   subscription  base fee with included storage, then overage (Spaces, Linode)
 *
 * usd_per_gb_month is always the MARGINAL rate — the per-GB price, or the
 * overage rate past a subscription's included amount.
 */

function rec(provider, canonical, o) {
  return {
    provider,
    region: canonical,
    region_code: PROVIDERS[provider].regions[canonical] ?? null,
    sku: o.sku,
    display_name: o.display_name ?? o.sku,
    model: o.model,
    usd_per_gb_month: round(o.usd_per_gb_month, 6),
    base_usd_per_month: round(o.base_usd_per_month ?? 0, 2),
    included_storage_gb: o.included_storage_gb ?? 0,
    free_storage_gb: o.free_storage_gb ?? 0,
    usd_per_million_writes: o.usd_per_million_writes != null ? round(o.usd_per_million_writes, 4) : null,
    usd_per_million_reads: o.usd_per_million_reads != null ? round(o.usd_per_million_reads, 4) : null,
    currency: 'USD',
    source_url: o.source_url,
    collected_at: new Date().toISOString(),
    source_verified_at: o.source_verified_at ?? null,
    confidence: o.confidence,
    notes: o.notes ?? [],
  };
}

async function aws() {
  // The S3 offer file is ~160 KB per region — parsed whole, no streaming.
  const out = [];
  const raw = {};
  for (const [canonical, code] of Object.entries(PROVIDERS.aws.regions)) {
    const url = `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/${code}/index.json`;
    const body = await getJSON(url);

    let firstTier = null;
    let put = null;
    let get = null;
    for (const p of Object.values(body.products ?? {})) {
      const a = p.attributes ?? {};
      const dims = Object.values(body.terms?.OnDemand?.[p.sku] ?? {})
        .flatMap((t) => Object.values(t.priceDimensions ?? {}));
      if (a.volumeType === 'Standard' && a.usagetype?.endsWith('TimedStorage-ByteHrs')) {
        const d = dims.find((x) => x.beginRange === '0');
        if (d) firstTier = parseFloat(d.pricePerUnit.USD);
      }
      if (a.group === 'S3-API-Tier1' && dims[0]) put = parseFloat(dims[0].pricePerUnit.USD) * 1e6;
      if (a.group === 'S3-API-Tier2' && dims[0]) get = parseFloat(dims[0].pricePerUnit.USD) * 1e6;
    }
    if (firstTier == null) continue;
    raw[canonical] = { firstTier, put, get };
    out.push(
      rec('aws', canonical, {
        sku: 's3-standard',
        display_name: 'S3 Standard',
        model: 'per-gb',
        usd_per_gb_month: firstTier,
        usd_per_million_writes: put,
        usd_per_million_reads: get,
        source_url: 'https://aws.amazon.com/s3/pricing/',
        confidence: 'high',
        notes: [
          'First 50 TB tier; 50-500 TB and 500 TB+ are about 4-9% cheaper.',
          'Egress bills at standard AWS internet rates — see the egress page.',
        ],
      }),
    );
  }
  await saveRaw('aws', 'objectstorage', raw);
  return out;
}

async function azure() {
  const out = [];
  const raw = {};
  for (const [canonical, code] of Object.entries(PROVIDERS.azure.regions)) {
    const filter =
      `serviceName eq 'Storage' and armRegionName eq '${code}' and ` +
      `productName eq 'Blob Storage' and priceType eq 'Consumption'`;
    const body = await getJSON(
      `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}`,
    );
    const stored = body.Items.find(
      (i) => i.meterName === 'Hot LRS Data Stored' && i.tierMinimumUnits === 0,
    );
    const write = body.Items.find((i) => i.meterName === 'Hot LRS Write Operations');
    const read = body.Items.find((i) => i.meterName === 'Hot Read Operations');
    if (!stored) continue;
    raw[canonical] = { stored, write, read };
    out.push(
      rec('azure', canonical, {
        sku: 'blob-hot-lrs',
        display_name: 'Blob Storage (Hot LRS)',
        model: 'per-gb',
        usd_per_gb_month: stored.retailPrice,
        usd_per_million_writes: write ? (write.retailPrice / 10_000) * 1e6 : null,
        usd_per_million_reads: read ? (read.retailPrice / 10_000) * 1e6 : null,
        source_url: 'https://azure.microsoft.com/en-us/pricing/details/storage/blobs/',
        confidence: 'high',
        notes: [
          'First 50 TB tier, locally-redundant (LRS). Higher redundancy costs more.',
          'Egress bills at standard Azure rates — see the egress page.',
        ],
      }),
    );
  }
  await saveRaw('azure', 'objectstorage', raw);
  return out;
}

async function gcp() {
  const key = process.env.GCP_API_KEY;
  if (!key) return { skipped: 'GCP_API_KEY not set — see README "Credentials"' };

  // Cloud Storage is its own billing service, distinct from Compute Engine.
  const SERVICE = '95FF-2EF5-5EA1';
  const skus = [];
  let token = '';
  do {
    const url =
      `https://cloudbilling.googleapis.com/v1/services/${SERVICE}/skus` +
      `?key=${key}&pageSize=5000${token ? `&pageToken=${token}` : ''}`;
    const body = await getJSON(url);
    skus.push(...(body.skus ?? []));
    token = body.nextPageToken;
  } while (token);

  const relevant = skus.filter(
    (s) => /^Standard Storage/i.test(s.description) && s.category?.usageType === 'OnDemand',
  );
  await saveRaw('gcp', 'objectstorage', relevant.slice(0, 50));

  const unitPrice = (sku) => {
    const r = sku.pricingInfo?.[0]?.pricingExpression?.tieredRates?.at(-1)?.unitPrice;
    return r ? Number(r.units ?? 0) + (r.nanos ?? 0) / 1e9 : null;
  };

  const out = [];
  for (const [canonical, code] of Object.entries(PROVIDERS.gcp.regions)) {
    const sku = relevant.find((s) => s.serviceRegions?.includes(code));
    const price = sku && unitPrice(sku);
    if (price == null) continue;
    out.push(
      rec('gcp', canonical, {
        sku: 'gcs-standard',
        display_name: 'Cloud Storage Standard',
        model: 'per-gb',
        usd_per_gb_month: price,
        usd_per_million_writes: 5,
        usd_per_million_reads: 0.4,
        source_url: 'https://cloud.google.com/storage/pricing',
        confidence: 'high',
        notes: [
          'Regional bucket. Class A (writes) $5/M and Class B (reads) $0.40/M are the published standard-storage rates.',
          'Egress bills at standard GCP rates — see the egress page.',
        ],
      }),
    );
  }
  return out;
}

async function oci() {
  const priceOf = async (pn) => {
    const body = await getJSON(
      `https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?partNumber=${pn}`,
    );
    const usd = body.items?.[0]?.currencyCodeLocalizations.find((c) => c.currencyCode === 'USD');
    const bands = (usd?.prices ?? []).filter((p) => p.model === 'PAY_AS_YOU_GO');
    return bands.sort((a, b) => a.rangeMin - b.rangeMin);
  };
  const storage = await priceOf('B91628'); // [0-10 free, then 0.0255]
  const requests = await priceOf('B91627'); // [first 50k free, then per 10k]
  await saveRaw('oci', 'objectstorage', { B91628: storage, B91627: requests });

  const perGb = storage.find((b) => b.value > 0)?.value;
  const per10k = requests.find((b) => b.value > 0)?.value;
  if (perGb == null) throw new Error('OCI object storage: no paid band');

  return Object.entries(PROVIDERS.oci.regions).map(([canonical]) =>
    rec('oci', canonical, {
      sku: 'oci-object-standard',
      display_name: 'Object Storage (Standard)',
      model: 'per-gb',
      usd_per_gb_month: perGb,
      free_storage_gb: storage[0]?.value === 0 ? storage[0].rangeMax : 0,
      usd_per_million_writes: per10k != null ? (per10k / 10_000) * 1e6 : null,
      usd_per_million_reads: per10k != null ? (per10k / 10_000) * 1e6 : null,
      source_url: 'https://www.oracle.com/cloud/storage/pricing/',
      confidence: 'high',
      notes: [
        'First 10 GB free; requests share one rate class, first 50,000/month free.',
        'Uniform list price across commercial regions. Egress shares the 10 TB/month free pool.',
      ],
    }),
  );
}

async function curated() {
  const file = JSON.parse(
    await readFile(resolve(ROOT, 'data/curated/objectstorage.json'), 'utf8'),
  );
  const out = [];
  for (const [provider, c] of Object.entries(file)) {
    if (provider.startsWith('_')) continue;
    for (const canonical of Object.keys(PROVIDERS[provider].regions)) {
      out.push(rec(provider, canonical, c));
    }
  }
  return out;
}

export default async function collect() {
  const out = [];
  const statuses = {};
  for (const [name, fn] of Object.entries({ aws, azure, gcp, oci, curated })) {
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
