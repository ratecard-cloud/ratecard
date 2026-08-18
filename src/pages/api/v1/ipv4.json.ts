import type { APIRoute } from 'astro';
import { IPV4 } from '../../../lib/data';
import { envelope, json } from '../../../lib/api';

export const GET: APIRoute = () =>
  json(
    envelope('ipv4', IPV4, {
      description:
        'The monthly cost of ONE public IPv4 on a running instance. $0 means ' +
        'bundled with no listed price — each $0 record cites the evidence, ' +
        'because included is the easiest claim to get wrong. Vultr is derived ' +
        'from the price delta between identical plans with and without IPv4. ' +
        'AWS charges idle and in-use alike; DigitalOcean bills unassigned ' +
        'reserved IPs ~$7/month.',
    }),
  );
