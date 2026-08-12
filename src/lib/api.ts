import { MANIFEST } from './data';

export const API_VERSION = 'v1';

/**
 * Every payload is wrapped rather than served as a bare array.
 *
 * The dataset is CC BY 4.0, so attribution has to travel with the bytes — a
 * consumer who fetches JSON should not have to visit a webpage to discover how
 * to credit it. The envelope also carries the collection timestamp, so stale
 * data is self-evident to anything caching it.
 */
export function envelope(resource: string, records: unknown[], extra: Record<string, unknown> = {}) {
  return {
    resource,
    version: API_VERSION,
    generated_at: MANIFEST.generated_at,
    count: records.length,
    license: 'CC-BY-4.0',
    license_url: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: 'Pricing data from RateCard (https://ratecard.cloud), CC BY 4.0.',
    documentation: 'https://ratecard.cloud/api',
    source: 'https://github.com/ratecard-cloud/ratecard',
    disclaimer:
      'Public list prices collected in good faith. Not a quote, not an offer, ' +
      'and sometimes wrong. Verify against the provider before spending money.',
    ...extra,
    records,
  };
}

/** Pretty-printed: these get read by humans at least as often as by programs. */
export function json(body: unknown) {
  return new Response(JSON.stringify(body, null, 2) + '\n', {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
