import type { APIRoute } from 'astro';
import { STORAGE } from '../../../lib/data';
import { envelope, json } from '../../../lib/api';

export const GET: APIRoute = () =>
  json(
    envelope('storage', STORAGE, {
      description:
        'Block storage: ONE general-purpose volume product per provider, ' +
        'normalised to USD per GB-month. AWS gp3 and Azure Premium SSD v2 both ' +
        'bundle a 3000 IOPS / 125 MB/s baseline and are directly comparable; ' +
        'other providers scale performance with size or VPUs — read the notes. ' +
        'Classic Azure managed disks price by fixed size tier and are ' +
        'deliberately not included.',
    }),
  );
