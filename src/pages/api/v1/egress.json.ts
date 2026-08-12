import type { APIRoute } from 'astro';
import { EGRESS } from '../../../lib/data';
import { envelope, json } from '../../../lib/api';

export const GET: APIRoute = () =>
  json(
    envelope('egress', EGRESS, {
      description:
        'Outbound-to-internet pricing. tiers are cumulative and measured AFTER ' +
        'free_gb_per_month is consumed; a null up_to_gb marks the unbounded final ' +
        'tier. bundled_with_compute means the real allowance lives on the compute ' +
        'record (included_egress_gb) and these tiers price only the overage.',
    }),
  );
