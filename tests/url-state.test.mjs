/**
 * URL-state tests: run the real public/compute.js (unmodified, in a vm
 * sandbox) and assert the read -> render -> write round trip. Shareable URLs
 * are a stated feature; a regression here breaks every deep link on the
 * homepage and every bookmarked comparison.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile('public/compute.js', 'utf8');
const compute = JSON.parse(await readFile('data/normalized/compute.json', 'utf8'));
const egress = JSON.parse(await readFile('data/normalized/egress.json', 'utf8'));

function el(extra = {}) {
  return {
    value: '', textContent: '', innerHTML: '', disabled: false, hidden: false,
    dataset: {}, attrs: {},
    addEventListener() {},
    setAttribute(k, v) { this.attrs[k] = v; },
    querySelectorAll: () => [],
    ...extra,
  };
}

/** Boot the island against a given URL; return the sandbox innards. */
function boot(search) {
  const sortHeaders = ['provider', 'sku', 'cpu', 'arch', 'bundled', 'hourly', 'base', 'eg', 'total']
    .map((k) => el({ dataset: { sort: k } }));
  const els = {
    'f-region': el({ value: 'us-east' }),
    'f-shape': el({ value: '4/16' }),
    'f-cpu': el(),
    'f-arch': el(),
    'f-egress': el({ value: '3' }),
    'egress-label': el(),
    'f-reset': el(),
    'f-pins-clear': el({ hidden: true }),
    'f-pins-count': el(),
    'grid-body': el(),
    'row-count': el(),
    grid: el({ querySelectorAll: (sel) => (sel === 'th[data-sort]' ? sortHeaders : []) }),
  };
  const history = { lastURL: null, replaceState(_s, _t, url) { this.lastURL = url; } };
  const sandbox = {
    window: {
      RCData: {
        boot(_controls, onReady) {
          onReady({ compute, egress, providers: { aws: { short: 'AWS' } } });
        },
      },
    },
    document: { getElementById: (id) => els[id] ?? null },
    location: { pathname: '/compute', search },
    history,
    matchMedia: () => ({ matches: true }), // reduced-motion: skips the flash path
    URLSearchParams,
    console,
  };
  vm.runInNewContext(source, sandbox, { filename: 'compute.js' });
  return { els, history, params: new URLSearchParams((history.lastURL ?? '').split('?')[1] ?? '') };
}

test('full state round-trips through the URL', () => {
  const { els, params } = boot(
    '?region=eu-central&shape=8/32&egress=20480&cpu=dedicated&arch=x86_64&sort=base&dir=desc&pin=hetzner:ccx33',
  );
  assert.equal(els['f-region'].value, 'eu-central');
  assert.equal(els['f-shape'].value, '8/32');
  assert.equal(els['f-cpu'].value, 'dedicated');
  assert.equal(els['f-arch'].value, 'x86_64');
  assert.equal(els['f-egress'].value, '6', '20480 GB maps to slider index 6');
  assert.equal(params.get('region'), 'eu-central');
  assert.equal(params.get('shape'), '8/32');
  assert.equal(params.get('egress'), '20480');
  assert.equal(params.get('sort'), 'base');
  assert.equal(params.get('dir'), 'desc');
  assert.equal(params.get('pin'), 'hetzner:ccx33');
  assert.ok(els['grid-body'].innerHTML.includes('is-pinned'), 'pinned row rendered pinned');
  assert.equal(els['f-pins-clear'].hidden, false, 'clear button surfaces');
});

test('invalid egress value falls back to the default instead of breaking', () => {
  const { els, params } = boot('?egress=999');
  assert.equal(els['f-egress'].value, '3', 'slider stays on its default index');
  assert.equal(params.get('egress'), '1024', 'URL is rewritten to a valid volume');
});

test('defaults produce a canonical, minimal URL', () => {
  const { params } = boot('');
  assert.equal(params.get('region'), 'us-east');
  assert.equal(params.get('shape'), '4/16');
  assert.equal(params.get('egress'), '1024');
  assert.equal(params.get('sort'), null, 'default sort is not serialised');
  assert.equal(params.get('pin'), null, 'no pins param when nothing pinned');
});

test('homepage deep-link volumes are values the slider can land on', async () => {
  // The invariant index.astro documents: a deep link must open on the number
  // the row promised, so every WORKLOADS gb must exist in the island's STEPS.
  const steps = JSON.parse(source.match(/var STEPS = (\[[^\]]+\])/)[1]);
  const home = await readFile('src/pages/index.astro', 'utf8');
  const gbs = [...home.matchAll(/\bgb:\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(gbs.length >= 4, `expected the WORKLOADS list, found ${gbs.length} gb values`);
  for (const gb of gbs) {
    assert.ok(steps.includes(gb), `homepage links egress=${gb} but the slider cannot land on it`);
  }
});
