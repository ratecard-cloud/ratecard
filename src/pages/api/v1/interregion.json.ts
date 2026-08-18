import type { APIRoute } from 'astro';
import { INTERREGION } from '../../../lib/data';
import { envelope, json } from '../../../lib/api';

export const GET: APIRoute = () =>
  json(
    envelope('interregion', INTERREGION, {
      description:
        'USD/GB to move data between two regions of the same provider, as ' +
        'DIRECTED pairs — the asymmetry is the finding: AWS and Azure charge ' +
        '$0.02/GB out of US or EU regions but $0.08-0.09 out of Singapore. ' +
        'billed_as "dedicated" means a real inter-region rate; ' +
        '"standard-egress" means the provider has no such rate and cross-region ' +
        'traffic simply bills as ordinary outgoing bandwidth (consumes_bundle ' +
        'tells you whether the plan allowance absorbs it first). GCP prices ' +
        'per GiB, noted per record.',
    }),
  );
