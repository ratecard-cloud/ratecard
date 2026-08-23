/**
 * getJSON's retry contract, pinned by the 2026-08-23 incident: one Azure 429
 * emptied the whole egress dataset. Transient 429/5xx retry with backoff;
 * client errors like 404 fail immediately.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { getJSON } from '../pipeline/lib.mjs';

/** Serve a scripted sequence of [status, body] responses, counting hits. */
function serve(script) {
  const state = { hits: 0 };
  const srv = createServer((req, res) => {
    const [status, body] = script[Math.min(state.hits, script.length - 1)];
    state.hits++;
    res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '0' });
    res.end(body);
  });
  return new Promise((ok) => {
    srv.listen(0, '127.0.0.1', () => {
      state.url = `http://127.0.0.1:${srv.address().port}/`;
      state.close = () => new Promise((r) => srv.close(r));
      ok(state);
    });
  });
}

test('a transient 429 is retried until it clears', async () => {
  const s = await serve([[429, '{}'], [429, '{}'], [200, '{"ok":true}']]);
  try {
    const body = await getJSON(s.url, { backoffMs: 10 });
    assert.deepEqual(body, { ok: true });
    assert.equal(s.hits, 3, 'two 429s absorbed, third attempt succeeded');
  } finally { await s.close(); }
});

test('retries are finite and surface the final status', async () => {
  const s = await serve([[503, '{}']]);
  try {
    await assert.rejects(() => getJSON(s.url, { retries: 2, backoffMs: 10 }), /503/);
    assert.equal(s.hits, 3, 'initial attempt + 2 retries');
  } finally { await s.close(); }
});

test('a client error is not retried', async () => {
  const s = await serve([[404, '{}']]);
  try {
    await assert.rejects(() => getJSON(s.url, { backoffMs: 10 }), /404/);
    assert.equal(s.hits, 1, '404 will not improve with repetition');
  } finally { await s.close(); }
});
