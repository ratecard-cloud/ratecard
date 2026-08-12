import type { APIRoute } from 'astro';
import { REGIONS, PROVIDERS } from '../../../lib/data';
import { envelope, json } from '../../../lib/api';

const records = Object.entries(REGIONS).map(([key, r]) => ({
  key,
  label: r.label,
  description: r.blurb,
  provider_codes: Object.fromEntries(
    Object.entries(PROVIDERS).map(([pk, p]) => [pk, p.regions[key] ?? null]),
  ),
}));

export const GET: APIRoute = () =>
  json(
    envelope('regions', records, {
      description:
        'Canonical regions and the provider-specific code each maps to. Prices ' +
        'are only ever compared within one canonical region.',
    }),
  );
