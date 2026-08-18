import type { APIRoute } from 'astro';
import { COMPUTE, EGRESS, STORAGE, PROVIDERS, REGIONS, MANIFEST } from '../../../lib/data';
import { SERIES, CHANGES } from '../../../lib/history';
import { API_VERSION, json } from '../../../lib/api';

const BASE = 'https://ratecard.cloud/api/v1';

/** Discovery document, so the API is explorable without reading the docs page. */
export const GET: APIRoute = () =>
  json({
    name: 'RateCard pricing API',
    version: API_VERSION,
    generated_at: MANIFEST.generated_at,
    documentation: 'https://ratecard.cloud/api',
    license: 'CC-BY-4.0',
    attribution: 'Pricing data from RateCard (https://ratecard.cloud), CC BY 4.0.',
    source: 'https://github.com/ratecard-cloud/ratecard',
    endpoints: [
      { resource: 'compute', url: `${BASE}/compute.json`, count: COMPUTE.length,
        description: 'On-demand VM list prices at matched vCPU/RAM.' },
      { resource: 'egress', url: `${BASE}/egress.json`, count: EGRESS.length,
        description: 'Outbound-to-internet pricing, tiered, with free allowances.' },
      { resource: 'providers', url: `${BASE}/providers.json`, count: Object.keys(PROVIDERS).length,
        description: 'Providers indexed, their kind and region mappings.' },
      { resource: 'regions', url: `${BASE}/regions.json`, count: Object.keys(REGIONS).length,
        description: 'Canonical regions and provider-specific codes.' },
      { resource: 'storage', url: `${BASE}/storage.json`, count: STORAGE.length,
        description: 'Block storage: one general-purpose volume per provider, $/GB-month.' },
      { resource: 'history', url: `${BASE}/history.json`, count: Object.keys(SERIES).length,
        description: 'Per-SKU price history as run-length segments.' },
      { resource: 'changes', url: `${BASE}/changes.json`, count: CHANGES.length,
        description: 'Daily changelog of price and coverage changes. RSS at /changes.xml.' },
    ],
    notes: {
      updates: 'Rebuilt daily. generated_at is when collectors last ran.',
      stability:
        'Fields are added, not removed or repurposed, within a version. ' +
        'A breaking change ships as /api/v2/ and v1 keeps working.',
      cors: 'Access-Control-Allow-Origin: * — safe to call from a browser.',
      cost: 'Free, unmetered, no key. Static files on a CDN.',
      accuracy:
        'Public list prices only. Excludes committed-use discounts, spot, ' +
        'negotiated rates, tax and support. Every record carries source_url, ' +
        'collected_at, source_verified_at and a confidence flag — read them.',
    },
  });
