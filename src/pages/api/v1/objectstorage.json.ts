import type { APIRoute } from 'astro';
import { OBJECTSTORAGE } from '../../../lib/data';
import { envelope, json } from '../../../lib/api';

export const GET: APIRoute = () =>
  json(
    envelope('objectstorage', OBJECTSTORAGE, {
      description:
        'Object storage, standard/hot tier. Two models, kept distinct: ' +
        '"per-gb" pays for what you store; "subscription" is a base fee with ' +
        'included storage, usd_per_gb_month then being the OVERAGE rate. ' +
        'Request pricing is per million operations where published; null means ' +
        'not separately charged or not published. Egress is the other half of ' +
        'this decision — R2 charges none, B2 gives 3x stored — see /api/v1/' +
        'egress.json. Hetzner Object Storage is deliberately absent: EU-only ' +
        'and its prices could not be verified.',
    }),
  );
