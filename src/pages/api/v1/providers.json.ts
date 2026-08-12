import type { APIRoute } from 'astro';
import { PROVIDERS } from '../../../lib/data';
import { envelope, json } from '../../../lib/api';

// affiliate is deliberately stripped: our referral links are ours, and they
// have no bearing on the data.
const records = Object.entries(PROVIDERS).map(([key, p]) => ({
  key,
  name: p.name,
  short: p.short,
  kind: p.kind,
  pricing_url: p.url,
  collection: p.collector,
  regions: p.regions,
}));

export const GET: APIRoute = () =>
  json(
    envelope('providers', records, {
      description:
        'Providers indexed here. kind is compute or object-storage; the two are ' +
        'never ranked against each other because they are not substitutes.',
    }),
  );
