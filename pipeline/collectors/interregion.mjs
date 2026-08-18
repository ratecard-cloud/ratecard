import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT, getJSON, saveRaw, PROVIDERS, REGIONS, round } from '../lib.mjs';
import { awsInterRegionHarvest } from './egress.mjs';

/**
 * Inter-region transfer: USD/GB to move data between two regions of the SAME
 * provider. Two structurally different worlds coexist here:
 *
 *   - Hyperscalers publish DEDICATED inter-region rates, usually cheaper than
 *     internet egress ($0.02 vs $0.09 on AWS) but sharply asymmetric out of
 *     Asia (Singapore-sourced transfer costs 4-4.5x on AWS and Azure).
 *   - Value providers have no such rate at all: cross-region traffic is just
 *     ordinary outgoing bandwidth, consumed from the plan bundle first.
 *
 * Records are directed pairs, because the asymmetry IS the finding.
 */

const PAIRS = REGIONS.flatMap((from) =>
  REGIONS.filter((to) => to !== from).map((to) => [from, to]),
);

function rec(provider, from, to, o) {
  return {
    provider,
    from_region: from,
    to_region: to,
    usd_per_gb: round(o.usd_per_gb, 6),
    billed_as: o.billed_as,
    consumes_bundle: o.consumes_bundle ?? false,
    currency: 'USD',
    source_url: o.source_url,
    collected_at: new Date().toISOString(),
    source_verified_at: o.source_verified_at ?? null,
    confidence: o.confidence,
    notes: o.notes ?? [],
  };
}

function aws() {
  if (!awsInterRegionHarvest.length) {
    return { skipped: 'egress collector did not run — inter-region rows ride its CSV stream' };
  }
  return awsInterRegionHarvest.map(({ from, to, usd_per_gb }) =>
    rec('aws', from, to, {
      usd_per_gb,
      billed_as: 'dedicated',
      source_url: 'https://aws.amazon.com/ec2/pricing/on-demand/',
      confidence: 'high',
      notes: usd_per_gb > 0.05
        ? ['Singapore-sourced inter-region transfer costs 4.5x the US/EU rate.']
        : [],
    }),
  );
}

async function azure() {
  const out = [];
  const raw = {};
  for (const [from, code] of Object.entries(PROVIDERS.azure.regions)) {
    const filter =
      `serviceName eq 'Bandwidth' and armRegionName eq '${code}' and ` +
      `contains(meterName, 'Inter-Region') and priceType eq 'Consumption'`;
    const body = await getJSON(
      `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}`,
    );
    const m = body.Items.find(
      (i) => i.meterName === 'Standard Inter-Region Data Transfer' && i.unitOfMeasure === '1 GB',
    );
    if (!m) continue;
    raw[from] = m;
    for (const to of REGIONS) {
      if (to === from) continue;
      out.push(
        rec('azure', from, to, {
          usd_per_gb: m.retailPrice,
          billed_as: 'dedicated',
          source_url: 'https://azure.microsoft.com/en-us/pricing/details/bandwidth/',
          confidence: 'high',
          notes: ['Priced by source region only; the destination does not matter.'],
        }),
      );
    }
  }
  await saveRaw('azure', 'interregion', raw);
  return out;
}

async function oci() {
  /**
   * OCI bills inter-region as ordinary outbound transfer — the same parts the
   * egress collector reads, sharing the same account-wide 10 TB free pool.
   */
  const part = { 'us-east': 'B88327', 'eu-central': 'B88327', 'us-west': 'B88327', 'ap-southeast': 'B93455' };
  const priceOf = async (pn) => {
    const body = await getJSON(
      `https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?partNumber=${pn}`,
    );
    const usd = body.items?.[0]?.currencyCodeLocalizations.find((c) => c.currencyCode === 'USD');
    const paid = usd?.prices.filter((p) => p.model === 'PAY_AS_YOU_GO' && p.value > 0) ?? [];
    if (!paid.length) throw new Error(`OCI part ${pn}: no paid band`);
    return paid[0].value;
  };
  const cache = {};
  const out = [];
  for (const [from, pn] of Object.entries(part)) {
    cache[pn] ??= await priceOf(pn);
    for (const to of REGIONS) {
      if (to === from) continue;
      out.push(
        rec('oci', from, to, {
          usd_per_gb: cache[pn],
          billed_as: 'standard-egress',
          consumes_bundle: false,
          source_url: 'https://www.oracle.com/cloud/networking/pricing/',
          confidence: 'high',
          notes: [
            'Billed as ordinary outbound transfer, sharing the account-wide 10 TB/month free pool.',
            'Rate shown is the post-free-pool rate for the source region.',
          ],
        }),
      );
    }
  }
  await saveRaw('oci', 'interregion', cache);
  return out;
}

async function curated() {
  const file = JSON.parse(await readFile(resolve(ROOT, 'data/curated/interregion.json'), 'utf8'));
  const out = [];
  for (const [provider, c] of Object.entries(file)) {
    if (provider.startsWith('_')) continue;

    if (c.matrix) {
      // Continent-matrix providers (GCP): map canonical regions through it.
      for (const [from, to] of PAIRS) {
        const rate = c.matrix[c.continent_of[from]]?.[c.continent_of[to]];
        if (rate == null) continue;
        out.push(
          rec(provider, from, to, {
            usd_per_gb: rate,
            billed_as: c.billed_as,
            source_url: c.source_url,
            source_verified_at: c.source_verified_at,
            confidence: c.confidence,
            notes: [...(c.notes ?? []), c.unit_note].filter(Boolean),
          }),
        );
      }
    } else {
      for (const [from, to] of PAIRS) {
        out.push(
          rec(provider, from, to, {
            usd_per_gb: c.usd_per_gb,
            billed_as: c.billed_as,
            consumes_bundle: c.consumes_bundle,
            source_url: c.source_url,
            source_verified_at: c.source_verified_at,
            confidence: c.confidence,
            notes: c.notes,
          }),
        );
      }
    }
  }
  return out;
}

export default async function collect() {
  const out = [];
  const statuses = {};
  for (const [name, fn] of Object.entries({ aws, azure, oci, curated })) {
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
