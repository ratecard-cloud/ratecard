/**
 * Shared dataset bootstrap for the interactive pages.
 *
 * The dataset used to be inlined into each page — 218 KB, and duplicated
 * between /compute and /placement. Fetching it from the public API instead
 * means one CDN-cached copy shared by both, and it exercises the same endpoint
 * third parties use, so the API cannot quietly rot.
 *
 * Every table is server-rendered first, so a failed or slow fetch degrades to a
 * correct static table rather than an empty one.
 */
window.RCData = (function () {
  var cache = null;

  function load() {
    if (cache) return cache;
    cache = Promise.all([
      fetch('/api/v1/compute.json').then(function (r) {
        if (!r.ok) throw new Error('compute ' + r.status);
        return r.json();
      }),
      fetch('/api/v1/egress.json').then(function (r) {
        if (!r.ok) throw new Error('egress ' + r.status);
        return r.json();
      }),
    ]).then(function (both) {
      var meta = window.__RCP_META__ || {};
      return {
        compute: both[0].records,
        egress: both[1].records,
        providers: meta.providers || {},
      };
    });
    return cache;
  }

  return {
    load: load,
    /**
     * Run `onReady` once data arrives. Controls stay usable throughout: they
     * are disabled only while loading, so nobody interacts with a filter that
     * silently does nothing.
     */
    boot: function (controls, onReady, onError) {
      controls.forEach(function (c) { if (c) c.disabled = true; });
      load().then(function (d) {
        controls.forEach(function (c) { if (c) c.disabled = false; });
        onReady(d);
      }).catch(function (err) {
        controls.forEach(function (c) { if (c) c.disabled = false; });
        if (onError) onError(err);
        // Server-rendered table stays on screen; interactivity is what is lost.
        console.warn('RateCard: dataset unavailable, table is static.', err);
      });
    },
  };
})();
