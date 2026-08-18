import type { APIRoute } from 'astro';
import { SERIES } from '../../../lib/history';
import { envelope, json } from '../../../lib/api';

const records = Object.entries(SERIES).map(([key, s]) => {
  const [provider, region, ...rest] = key.split('/');
  return { provider, region, sku: rest.join('/'), ...s };
});

export const GET: APIRoute = () =>
  json(
    envelope('history', records, {
      description:
        'Per-SKU price history as run-length segments: a new segment only when ' +
        'the price changed, so a flat price is one segment however long it ' +
        'holds. `removed` marks the day a SKU left the dataset (for providers ' +
        'like DigitalOcean this includes capacity churn, not only retirement). ' +
        'History starts 2026-08-11.',
    }),
  );
