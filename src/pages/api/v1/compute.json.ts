import type { APIRoute } from 'astro';
import { COMPUTE } from '../../../lib/data';
import { envelope, json } from '../../../lib/api';

export const GET: APIRoute = () =>
  json(
    envelope('compute', COMPUTE, {
      description:
        'On-demand Linux VM list prices at matched vCPU/RAM. vcpu_type ' +
        '(shared|dedicated) and vcpu_unit (thread|core) are required fields: an ' +
        'x86 vCPU is one hyperthread, an ARM vCPU is a whole physical core, and ' +
        'the two are not interchangeable at the same count.',
    }),
  );
