import type { APIRoute } from 'astro';
import { CHANGES } from '../../../lib/history';
import { envelope, json } from '../../../lib/api';

export const GET: APIRoute = () =>
  json(
    envelope('changes', CHANGES, {
      description:
        'Chronological changelog, newest first: price_changed, sku_added, ' +
        'sku_removed, allowance_changed and egress_changed events, derived ' +
        'daily by diffing consecutive published datasets. Poll this with ' +
        'If-None-Match/ETag or subscribe to /changes.xml; the `generated_at` ' +
        'field in this envelope tells you when the data behind it was collected.',
    }),
  );
