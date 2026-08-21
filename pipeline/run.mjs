#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT, saveNormalized } from './lib.mjs';
import {
  validateCompute, validateEgress, validateStorage, validateIpv4,
  validateInterRegion, validateObjectStorage, validateCoverage, validateProviders, validatePreviousCoverage,
  recordCoverage,
} from './validate.mjs';

import aws from './collectors/aws.mjs';
import azure from './collectors/azure.mjs';
import gcp from './collectors/gcp.mjs';
import oci from './collectors/oci.mjs';
import hetzner from './collectors/hetzner.mjs';
import digitalocean from './collectors/digitalocean.mjs';
import linode from './collectors/linode.mjs';
import vultr from './collectors/vultr.mjs';
import egressCollector from './collectors/egress.mjs';
import storageCollector from './collectors/storage.mjs';
import ipv4Collector from './collectors/ipv4.mjs';
import interregionCollector from './collectors/interregion.mjs';
import objectStorageCollector from './collectors/objectstorage.mjs';

const COMPUTE = { aws, azure, gcp, oci, hetzner, digitalocean, linode, vultr };

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const c = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', d: '\x1b[2m', x: '\x1b[0m' };

async function main() {
  const started = Date.now();
  const compute = [];
  const status = {};

  for (const [name, collect] of Object.entries(COMPUTE)) {
    if (only.length && !only.includes(name)) continue;
    const t0 = Date.now();
    try {
      const res = await collect();
      if (res && !Array.isArray(res) && res.skipped) {
        status[name] = { state: 'skipped', reason: res.skipped };
        console.log(`${c.y}○ ${name.padEnd(13)} skipped${c.x} ${c.d}${res.skipped}${c.x}`);
        continue;
      }
      compute.push(...res);
      status[name] = { state: 'ok', records: res.length, ms: Date.now() - t0 };
      console.log(
        `${c.g}✓ ${name.padEnd(13)}${c.x} ${String(res.length).padStart(3)} records ` +
          `${c.d}${((Date.now() - t0) / 1000).toFixed(1)}s${c.x}`,
      );
    } catch (err) {
      status[name] = { state: 'failed', error: String(err.message ?? err) };
      console.log(`${c.r}✗ ${name.padEnd(13)} failed${c.x}  ${err.message}`);
    }
  }

  let egress = [];
  try {
    egress = await egressCollector();
    console.log(`${c.g}✓ ${'egress'.padEnd(13)}${c.x} ${String(egress.length).padStart(3)} schedules`);
  } catch (err) {
    console.log(`${c.r}✗ egress failed${c.x} ${err.message}`);
  }

  let storage = [];
  try {
    const res = await storageCollector();
    storage = res.records;
    const skips = Object.entries(res.statuses).filter(([, v]) => v.state !== 'ok');
    console.log(
      `${c.g}✓ ${'storage'.padEnd(13)}${c.x} ${String(storage.length).padStart(3)} volumes` +
        (skips.length ? ` ${c.d}(${skips.map(([k, v]) => `${k}: ${v.state}`).join(', ')})${c.x}` : ''),
    );
    for (const [k, v] of skips) {
      if (v.state === 'failed') console.log(`${c.r}  storage/${k} failed${c.x} ${v.error}`);
    }
  } catch (err) {
    console.log(`${c.r}✗ storage failed${c.x} ${err.message}`);
  }

  let ipv4 = [];
  try {
    const res = await ipv4Collector();
    ipv4 = res.records;
    const skips = Object.entries(res.statuses).filter(([, v]) => v.state !== 'ok');
    console.log(
      `${c.g}✓ ${'ipv4'.padEnd(13)}${c.x} ${String(ipv4.length).padStart(3)} addresses` +
        (skips.length ? ` ${c.d}(${skips.map(([k, v]) => `${k}: ${v.state}`).join(', ')})${c.x}` : ''),
    );
    for (const [k, v] of skips) {
      if (v.state === 'failed') console.log(`${c.r}  ipv4/${k} failed${c.x} ${v.error}`);
    }
  } catch (err) {
    console.log(`${c.r}✗ ipv4 failed${c.x} ${err.message}`);
  }

  let interregion = [];
  try {
    const res = await interregionCollector();
    interregion = res.records;
    const skips = Object.entries(res.statuses).filter(([, v]) => v.state !== 'ok');
    console.log(
      `${c.g}✓ ${'interregion'.padEnd(13)}${c.x} ${String(interregion.length).padStart(3)} pairs` +
        (skips.length ? ` ${c.d}(${skips.map(([k, v]) => `${k}: ${v.state}`).join(', ')})${c.x}` : ''),
    );
    for (const [k, v] of skips) {
      if (v.state === 'failed') console.log(`${c.r}  interregion/${k} failed${c.x} ${v.error}`);
    }
  } catch (err) {
    console.log(`${c.r}✗ interregion failed${c.x} ${err.message}`);
  }

  let objectstorage = [];
  try {
    const res = await objectStorageCollector();
    objectstorage = res.records;
    const skips = Object.entries(res.statuses).filter(([, v]) => v.state !== 'ok');
    console.log(
      `${c.g}✓ ${'objectstorage'.padEnd(13)}${c.x} ${String(objectstorage.length).padStart(3)} buckets` +
        (skips.length ? ` ${c.d}(${skips.map(([k, v]) => `${k}: ${v.state}`).join(', ')})${c.x}` : ''),
    );
    for (const [k, v] of skips) {
      if (v.state === 'failed') console.log(`${c.r}  objectstorage/${k} failed${c.x} ${v.error}`);
    }
  } catch (err) {
    console.log(`${c.r}✗ objectstorage failed${c.x} ${err.message}`);
  }

  // --------------------------------------------------------------- validate
  const checks = [
    ['providers', validateProviders()],
    ['compute', validateCompute(compute)],
    ['egress', validateEgress(egress)],
    ['storage', validateStorage(storage)],
    ['ipv4', validateIpv4(ipv4)],
    ['interregion', validateInterRegion(interregion)],
    ['objectstorage', validateObjectStorage(objectstorage)],
    ['coverage', validateCoverage(compute, egress)],
  ];
  // Single-collector debug runs are partial by design; comparing them against
  // the full published dataset would always fail.
  if (!only.length) {
    checks.push(['regression', await validatePreviousCoverage(compute, egress, status, { storage, ipv4, interregion, objectstorage })]);
  }
  let fatal = 0;
  for (const [label, { errors, warnings }] of checks) {
    for (const w of warnings) console.log(`${c.y}  warn [${label}]${c.x} ${w}`);
    for (const e of errors) { console.log(`${c.r}  ERR  [${label}]${c.x} ${e}`); fatal++; }
  }
  if (fatal) {
    console.error(`\n${c.r}${fatal} validation error(s) — refusing to write.${c.x}`);
    process.exit(1);
  }

  // ------------------------------------------------------------------ write
  if (!only.length) {
    await saveNormalized('compute', compute);
    await saveNormalized('egress', egress);
    await saveNormalized('storage', storage);
    await saveNormalized('ipv4', ipv4);
    await saveNormalized('interregion', interregion);
    await saveNormalized('objectstorage', objectstorage);
    // Record today's accepted per-key counts so a future flap back to this
    // state passes the regression check without a manual override.
    await recordCoverage({ compute, egress, storage, ipv4, interregion, objectstorage });
    await writeFile(
      resolve(ROOT, 'data/normalized/manifest.json'),
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          duration_ms: Date.now() - started,
          compute_records: compute.length,
          egress_records: egress.length,
          storage_records: storage.length,
          ipv4_records: ipv4.length,
          interregion_records: interregion.length,
          objectstorage_records: objectstorage.length,
          providers: status,
        },
        null,
        1,
      ) + '\n',
    );
  }

  const live = Object.values(status).filter((s) => s.state === 'ok').length;
  console.log(
    `\n${c.g}${compute.length}${c.x} compute records from ${c.g}${live}${c.x} providers, ` +
      `${c.g}${egress.length}${c.x} egress schedules in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
