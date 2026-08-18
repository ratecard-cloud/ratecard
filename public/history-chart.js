/**
 * Price-over-time chart on /changes. Fetches the public history API — same
 * data any third party gets — and draws a stepped line as inline SVG. No
 * library: the data is run-length segments, which IS a step function.
 */
(function () {
  var provider = document.getElementById('h-provider');
  var sku = document.getElementById('h-sku');
  var chart = document.getElementById('h-chart');
  if (!provider || !sku || !chart) return;

  var records = [];

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function fillProviders() {
    var seen = {};
    records.forEach(function (r) { seen[r.provider] = true; });
    provider.innerHTML = Object.keys(seen).sort().map(function (p) {
      return '<option value="' + esc(p) + '">' + esc(p) + '</option>';
    }).join('');
  }

  function fillSkus() {
    var rows = records
      .filter(function (r) { return r.provider === provider.value && !r.removed; })
      .sort(function (a, b) { return (a.region + a.sku).localeCompare(b.region + b.sku); });
    sku.innerHTML = rows.map(function (r) {
      var key = r.provider + '/' + r.region + '/' + r.sku;
      return '<option value="' + esc(key) + '">' + esc(r.sku + ' · ' + r.region) + '</option>';
    }).join('');
  }

  function draw() {
    var rec = records.find(function (r) {
      return r.provider + '/' + r.region + '/' + r.sku === sku.value;
    });
    if (!rec) { chart.innerHTML = ''; return; }

    var segs = rec.segments;
    var start = new Date(rec.first_seen).getTime();
    var end = new Date(rec.removed || rec.last_seen).getTime();
    var span = Math.max(end - start, 86400000);
    var prices = segs.map(function (s) { return s.monthly; });
    var min = Math.min.apply(null, prices);
    var max = Math.max.apply(null, prices);
    // Flat series: pad the scale so the line sits mid-chart, not on the edge.
    if (max - min < max * 0.1) { var pad = max * 0.1 || 1; min -= pad; max += pad; }

    var W = 640, H = 130, L = 54, B = 18;
    var x = function (t) { return L + ((t - start) / span) * (W - L - 8); };
    var y = function (p) { return (H - B) - ((p - min) / (max - min)) * (H - B - 8); };

    // Step function: hold each segment's price until the next begins.
    var d = '';
    for (var i = 0; i < segs.length; i++) {
      var t0 = new Date(segs[i].since).getTime();
      var t1 = i + 1 < segs.length ? new Date(segs[i + 1].since).getTime() : end;
      d += (i ? 'L' : 'M') + x(t0).toFixed(1) + ' ' + y(segs[i].monthly).toFixed(1);
      d += 'L' + x(t1).toFixed(1) + ' ' + y(segs[i].monthly).toFixed(1);
    }

    var last = segs[segs.length - 1];
    chart.innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-width:680px" role="img" ' +
      'aria-label="Monthly price of ' + esc(rec.sku) + ' over time">' +
      '<text x="' + (L - 6) + '" y="' + (y(max) + 4) + '" text-anchor="end" font-size="10" fill="var(--fg-faint)">$' + max.toFixed(2) + '</text>' +
      '<text x="' + (L - 6) + '" y="' + (y(min) + 4) + '" text-anchor="end" font-size="10" fill="var(--fg-faint)">$' + min.toFixed(2) + '</text>' +
      '<line x1="' + L + '" y1="' + (H - B) + '" x2="' + (W - 8) + '" y2="' + (H - B) + '" stroke="var(--border)"/>' +
      '<text x="' + L + '" y="' + (H - 4) + '" font-size="10" fill="var(--fg-faint)">' + esc(rec.first_seen) + '</text>' +
      '<text x="' + (W - 8) + '" y="' + (H - 4) + '" text-anchor="end" font-size="10" fill="var(--fg-faint)">' + esc(rec.removed || rec.last_seen) + '</text>' +
      '<path d="' + d + '" fill="none" stroke="var(--accent)" stroke-width="2"/>' +
      '</svg>' +
      '<div class="faint" style="font-size:12px;margin-top:2px">' +
      (segs.length === 1
        ? 'Unchanged at $' + last.monthly + '/mo since ' + esc(rec.first_seen) + '.'
        : segs.length + ' price levels; currently $' + last.monthly + '/mo.') +
      (rec.removed ? ' No longer offered as of ' + esc(rec.removed) + '.' : '') +
      '</div>';
  }

  fetch('/api/v1/history.json')
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (body) {
      records = body.records;
      provider.disabled = false;
      sku.disabled = false;
      fillProviders();
      // Open on the most interesting series: most price levels wins.
      var top = records.slice().sort(function (a, b) { return b.segments.length - a.segments.length; })[0];
      if (top) provider.value = top.provider;
      fillSkus();
      if (top) sku.value = top.provider + '/' + top.region + '/' + top.sku;
      draw();
      provider.addEventListener('change', function () { fillSkus(); draw(); });
      sku.addEventListener('change', draw);
    })
    .catch(function (e) {
      chart.innerHTML = '<span class="faint" style="font-size:12.5px">History unavailable right now.</span>';
      console.warn('history chart:', e);
    });
})();
