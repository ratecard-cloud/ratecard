#!/usr/bin/env node
/**
 * Materialize price history into data/history/.
 *
 * Default mode is INCREMENTAL: fold the current data/normalized/ snapshot into
 * the committed history files. No git required — CI checkouts are shallow and
 * the same daily commit that carries the refreshed prices carries the updated
 * history, so the files never drift from the data.
 *
 *   node pipeline/history.mjs               # append today's snapshot
 *   node pipeline/history.mjs --backfill    # rebuild from git (full clone only)
 *
 * Backfill replays every committed version of the normalized files, last
 * commit per day winning, through the exact same step() as daily runs.
 */
import { execSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT } from './lib.mjs';
import { step, emptyHistory } from './history-lib.mjs';

const DIR = resolve(ROOT, 'data/history');
const today = () => new Date().toISOString().slice(0, 10);

async function loadJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

async function loadHistory() {
  return {
    state: await loadJSON(resolve(DIR, 'state.json'), emptyHistory().state),
    series: await loadJSON(resolve(DIR, 'series.json'), {}),
    changes: await loadJSON(resolve(DIR, 'changes.json'), []),
  };
}

async function save(h) {
  await mkdir(DIR, { recursive: true });
  await writeFile(resolve(DIR, 'state.json'), JSON.stringify(h.state) + '\n');
  await writeFile(resolve(DIR, 'series.json'), JSON.stringify(h.series, null, 1) + '\n');
  await writeFile(resolve(DIR, 'changes.json'), JSON.stringify(h.changes, null, 1) + '\n');
}

function gitVersions() {
  // Oldest first; last commit of each day wins.
  const log = execSync(
    'git log --reverse --format="%H %ad" --date=short -- data/normalized/compute.json',
    { cwd: ROOT, encoding: 'utf8' },
  ).trim();
  const byDay = new Map();
  for (const line of log.split('\n').filter(Boolean)) {
    const [sha, date] = line.split(' ');
    byDay.set(date, sha); // later lines overwrite: last commit per day
  }
  return [...byDay.entries()];
}

function gitShow(sha, path) {
  try {
    return JSON.parse(execSync(`git show ${sha}:${path}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  } catch {
    return null;
  }
}

async function main() {
  if (process.argv.includes('--backfill')) {
    let h = emptyHistory();
    let days = 0;
    for (const [date, sha] of gitVersions()) {
      const compute = gitShow(sha, 'data/normalized/compute.json');
      const egress = gitShow(sha, 'data/normalized/egress.json');
      if (!compute || !egress) { console.log(`  skip ${date} (${sha.slice(0, 7)}): unreadable`); continue; }
      h = step(h, compute, egress, date);
      days++;
    }
    await save(h);
    console.log(`backfilled ${days} day(s): ${Object.keys(h.series).length} series, ${h.changes.length} events`);
    return;
  }

  const compute = await loadJSON(resolve(ROOT, 'data/normalized/compute.json'), null);
  const egress = await loadJSON(resolve(ROOT, 'data/normalized/egress.json'), null);
  if (!compute || !egress) {
    console.error('history: no normalized data to fold in');
    process.exit(1);
  }
  const h = step(await loadHistory(), compute, egress, today());
  await save(h);
  const todays = h.changes.filter((c) => c.date === today()).length;
  console.log(`history: ${Object.keys(h.series).length} series, ${h.changes.length} events (${todays} today)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
