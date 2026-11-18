/**
 * AWS inter-region rows are harvested from the data-transfer CSV. On
 * 2026-11-18 AWS added "MultipathResilience" rows for us-east-1 <-> us-west-2
 * with the same Transfer Type as standard transfer, and the run failed on
 * duplicate pairs. Rows below are copied from that day's price list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.RC_NO_WRITE = '1';
const { isStandardInterRegion } = await import('../pipeline/collectors/egress.mjs');

const row = (usageType, price, extra = {}) => ({
  'Transfer Type': 'InterRegion Outbound',
  Unit: 'GB',
  'From Location': 'US East (N. Virginia)',
  'To Location': 'US West (Oregon)',
  usageType,
  PricePerUnit: price,
  ...extra,
});

test('standard inter-region transfer is kept', () => {
  assert.ok(isStandardInterRegion(row('USE1-USW2-AWS-Out-Bytes', '0.0200000000')));
});

test('MultipathResilience on the same pair is not standard transfer', () => {
  assert.ok(!isStandardInterRegion(row('USE1-USW2-MultipathResilience-Out-Bytes', '0.0300000000')));
});

test('non-GB and non-inter-region rows stay out', () => {
  assert.ok(!isStandardInterRegion(row('USE1-USW2-AWS-Out-Bytes', '0.02', { Unit: 'Hrs' })));
  assert.ok(!isStandardInterRegion(row('USE1-USW2-AWS-Out-Bytes', '0.02', { 'Transfer Type': 'AWS Outbound' })));
});
