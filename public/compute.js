/**
 * Compute grid island. Plain DOM, no framework — the table is already in the
 * HTML from the server render, so this only takes over on first interaction.
 * State lives in the URL so any view can be linked or bookmarked.
 */
(function () {
  // Populated by the shared loader; every read of D happens after boot().
  var D = null;

  var STEPS = [0, 100, 500, 1024, 5120, 10240, 20480, 51200, 102400];

  var el = {
    region: document.getElementById('f-region'),
    shape: document.getElementById('f-shape'),
    cpu: document.getElementById('f-cpu'),
    arch: document.getElementById('f-arch'),
    egress: document.getElementById('f-egress'),
    egressLabel: document.getElementById('egress-label'),
    reset: document.getElementById('f-reset'),
    pinsClear: document.getElementById('f-pins-clear'),
    pinsCount: document.getElementById('f-pins-count'),
    body: document.getElementById('grid-body'),
    count: document.getElementById('row-count'),
    table: document.getElementById('grid'),
  };

  var sort = { key: 'total', dir: 1 };
  /* Pinned rows float to the top of whatever the current filter produces, so a
     handful of candidates can be read side by side instead of scrolling a long
     list. Keyed by provider:sku so a pin survives re-sorting and re-filtering. */
  var pins = [];
  var pinKey = function (r) { return r.provider + ':' + r.sku; };

  /* ------------------------------------------------------------ helpers */
  function gbLabel(gb) {
    if (!gb) return '0';
    if (gb >= 1024) {
      var t = gb / 1024;
      return (t % 1 ? t.toFixed(1) : t) + ' TB';
    }
    return gb + ' GB';
  }

  function usd(n) {
    return n >= 1000
      ? '$' + Math.round(n).toLocaleString('en-US')
      : '$' + n.toFixed(2);
  }

  function schedule(provider, region) {
    for (var i = 0; i < D.egress.length; i++) {
      var e = D.egress[i];
      if (e.provider === provider && e.region === region) return e;
    }
  }

  function egressCost(sched, gb) {
    if (!sched) return 0;
    var remaining = Math.max(0, gb - (sched.free_gb_per_month || 0));
    var cost = 0, floor = 0;
    for (var i = 0; i < sched.tiers.length; i++) {
      if (remaining <= 0) break;
      var t = sched.tiers[i];
      var span = t.up_to_gb == null ? Infinity : t.up_to_gb - floor;
      var used = Math.min(remaining, span);
      cost += used * t.usd_per_gb;
      remaining -= used;
      floor = t.up_to_gb == null ? floor : t.up_to_gb;
    }
    return Math.round(cost * 100) / 100;
  }

  /* --------------------------------------------------------------- state */
  function readURL() {
    var q = new URLSearchParams(location.search);
    if (q.get('region')) el.region.value = q.get('region');
    if (q.get('shape')) el.shape.value = q.get('shape');
    if (q.get('cpu')) el.cpu.value = q.get('cpu');
    if (q.get('arch')) el.arch.value = q.get('arch');
    var eg = q.get('egress');
    if (eg != null) {
      var idx = STEPS.indexOf(parseInt(eg, 10));
      if (idx >= 0) el.egress.value = String(idx);
    }
    if (q.get('sort')) {
      sort.key = q.get('sort');
      sort.dir = q.get('dir') === 'desc' ? -1 : 1;
    }
    if (q.get('pin')) pins = q.get('pin').split(',').filter(Boolean);
  }

  function writeURL() {
    var q = new URLSearchParams();
    q.set('region', el.region.value);
    q.set('shape', el.shape.value);
    if (el.cpu.value) q.set('cpu', el.cpu.value);
    if (el.arch.value) q.set('arch', el.arch.value);
    q.set('egress', String(STEPS[+el.egress.value]));
    if (sort.key !== 'total' || sort.dir !== 1) {
      q.set('sort', sort.key);
      q.set('dir', sort.dir === -1 ? 'desc' : 'asc');
    }
    if (pins.length) q.set('pin', pins.join(','));
    history.replaceState(null, '', location.pathname + '?' + q.toString());
  }

  /* -------------------------------------------------------------- render */
  function rows() {
    var parts = el.shape.value.split('/');
    var vcpu = +parts[0], ram = +parts[1];
    var region = el.region.value;
    var gb = STEPS[+el.egress.value];
    var out = [];

    for (var i = 0; i < D.compute.length; i++) {
      var r = D.compute[i];
      if (r.region !== region) continue;
      if (r.vcpu !== vcpu || r.ram_gb !== ram) continue;
      if (el.cpu.value && r.vcpu_type !== el.cpu.value) continue;
      if (el.arch.value && r.arch !== el.arch.value) continue;

      var billable = Math.max(0, gb - (r.included_egress_gb || 0));
      var eg = egressCost(schedule(r.provider, r.region), billable);
      out.push({ r: r, eg: eg, total: Math.round((r.price_monthly_usd + eg) * 100) / 100 });
    }

    var key = sort.key, dir = sort.dir;
    out.sort(function (a, b) {
      var av, bv;
      switch (key) {
        case 'provider': av = a.r.provider; bv = b.r.provider; break;
        case 'sku': av = a.r.display_name; bv = b.r.display_name; break;
        case 'cpu': av = a.r.vcpu_type; bv = b.r.vcpu_type; break;
        case 'arch': av = a.r.arch; bv = b.r.arch; break;
        case 'bundled': av = a.r.included_egress_gb; bv = b.r.included_egress_gb; break;
        case 'hourly': av = a.r.price_hourly_usd; bv = b.r.price_hourly_usd; break;
        case 'base': av = a.r.price_monthly_usd; bv = b.r.price_monthly_usd; break;
        case 'eg': av = a.eg; bv = b.eg; break;
        default: av = a.total; bv = b.total;
      }
      if (typeof av === 'string') return dir * av.localeCompare(bv);
      return dir * (av - bv);
    });

    if (!pins.length) return out;
    var top = [], rest = [];
    for (var n = 0; n < out.length; n++) {
      (pins.indexOf(pinKey(out[n].r)) >= 0 ? top : rest).push(out[n]);
    }
    return top.concat(rest);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function render(flash) {
    var data = rows();
    var min = data.length
      ? data.reduce(function (m, d) { return Math.min(m, d.total); }, Infinity)
      : null;

    var html = '';
    for (var i = 0; i < data.length; i++) {
      var d = data[i], r = d.r;
      var best = d.total === min;
      var p = D.providers[r.provider] || { short: r.provider };
      var key = pinKey(r);
      var pinned = pins.indexOf(key) >= 0;
      // Rule off the last pinned row so the group reads as a group.
      var lastPinned = pinned && (i + 1 === data.length || pins.indexOf(pinKey(data[i + 1].r)) < 0);

      html +=
        '<tr class="' + (best ? 'is-cheapest ' : '') + (pinned ? 'is-pinned ' : '') +
        (lastPinned ? 'pin-last' : '') + '">' +
        '<td data-label="Provider"><label class="pin-wrap">' +
        '<input type="checkbox" class="pin" data-key="' + esc(key) + '"' +
        (pinned ? ' checked' : '') +
        ' aria-label="Pin ' + esc(p.short) + ' ' + esc(r.display_name) + ' to the top">' +
        '<strong>' + esc(p.short) + '</strong></label></td>' +
        '<td class="num" data-label="Instance">' + esc(r.display_name) + '</td>' +
        '<td data-label="CPU"><span class="chip chip-' + r.vcpu_type + '">' + r.vcpu_type + '</span>' +
        '<span class="faint" style="font-size:11.5px"> ' + r.vcpu_unit + 's</span></td>' +
        '<td class="col-optional" data-label="Arch">' + (r.arch === 'arm64'
          ? '<span class="chip chip-arm">ARM</span>'
          : '<span class="faint" style="font-size:12px">x86</span>') + '</td>' +
        '<td class="right num faint col-optional" data-label="Bundled egress">' + gbLabel(r.included_egress_gb) + '</td>' +
        '<td class="right num muted col-optional" data-label="$/hr">$' + r.price_hourly_usd.toFixed(4) + '</td>' +
        '<td class="right num muted" data-label="$/mo">' + usd(r.price_monthly_usd) + '</td>' +
        '<td class="right num" data-label="+ egress" style="color:' + (d.eg > 0 ? 'var(--warn)' : 'var(--fg-faint)') + '">' +
        (d.eg > 0 ? usd(d.eg) : '—') + '</td>' +
        '<td class="right num" data-label="Effective $/mo" style="font-weight:700">' + usd(d.total) +
        (best ? '<span class="chip chip-win" style="margin-left:6px">cheapest</span>' : '') + '</td>' +
        '<td data-label="Source"><a href="' + esc(r.source_url) + '" rel="nofollow noopener" target="_blank" ' +
        'class="faint" style="font-size:12px">source ↗</a></td>' +
        '</tr>';
    }

    if (!data.length) {
      html =
        '<tr><td colspan="10" style="padding:26px;text-align:center" class="muted">' +
        'No instances match this combination. Not every provider offers every shape ' +
        'in every region — try widening the CPU or architecture filter.</td></tr>';
    }

    el.body.innerHTML = html;
    el.count.textContent = String(data.length);
    el.egressLabel.textContent = gbLabel(STEPS[+el.egress.value]);

    // Tint the headline column when the slider caused the change, so the
    // re-ranking reads as a consequence rather than the table just blinking.
    // Skipped when the user prefers reduced motion.
    if (flash && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      var cells = el.body.querySelectorAll('tr > td:nth-child(9)');
      for (var k = 0; k < cells.length; k++) cells[k].classList.add('flash');
    }

    var ths = el.table.querySelectorAll('th[data-sort]');
    for (var j = 0; j < ths.length; j++) {
      ths[j].setAttribute(
        'aria-sort',
        ths[j].dataset.sort === sort.key
          ? (sort.dir === 1 ? 'ascending' : 'descending')
          : 'none',
      );
    }
    if (el.pinsClear && el.pinsCount) {
      el.pinsCount.textContent = String(pins.length);
      el.pinsClear.hidden = pins.length === 0;
    }
    writeURL();
  }

  /* --------------------------------------------------------------- wiring */
  ['region', 'shape', 'cpu', 'arch'].forEach(function (k) {
    el[k].addEventListener('change', function () { render(); });
  });
  el.egress.addEventListener('input', function () { render(true); });

  el.body.addEventListener('change', function (ev) {
    var box = ev.target;
    if (!box || !box.classList || !box.classList.contains('pin')) return;
    var key = box.dataset.key;
    var at = pins.indexOf(key);
    if (box.checked && at < 0) pins.push(key);
    else if (!box.checked && at >= 0) pins.splice(at, 1);
    render();
  });

  if (el.pinsClear) {
    el.pinsClear.addEventListener('click', function () { pins = []; render(); });
  }

  el.reset.addEventListener('click', function () {
    el.region.value = 'us-east';
    el.shape.value = '4/16';
    el.cpu.value = '';
    el.arch.value = '';
    el.egress.value = '3';
    pins = [];
    sort = { key: 'total', dir: 1 };
    render();
  });

  el.table.querySelectorAll('th[data-sort]').forEach(function (th) {
    th.setAttribute('tabindex', '0');
    function go() {
      var k = th.dataset.sort;
      // Numeric columns are most useful ascending first; text columns too.
      if (sort.key === k) sort.dir = -sort.dir;
      else { sort.key = k; sort.dir = 1; }
      render();
    }
    th.addEventListener('click', go);
    th.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  });

  readURL();

  // Table is already server-rendered and correct; this only adds interactivity.
  window.RCData.boot(
    [el.region, el.shape, el.cpu, el.arch, el.egress, el.reset],
    function (data) { D = data; render(); },
  );
})();
