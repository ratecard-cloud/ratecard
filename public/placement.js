/**
 * Placement island. Same contract as the compute grid: the table is already
 * server-rendered, this takes over on first interaction and keeps all state in
 * the URL so a recommendation can be linked to someone else.
 */
(function () {
  var D = window.__RCP__;
  if (!D) return;

  var EGRESS_STEPS = [0, 100, 500, 1024, 5120, 10240, 20480, 51200, 102400];
  var DATA_STEPS = [0, 100, 500, 1024, 5120, 10240, 51200, 102400];

  var el = {
    region: document.getElementById('p-region'),
    shape: document.getElementById('p-shape'),
    from: document.getElementById('p-from'),
    egress: document.getElementById('p-egress'),
    dataset: document.getElementById('p-dataset'),
    egressLabel: document.getElementById('p-egress-label'),
    datasetLabel: document.getElementById('p-dataset-label'),
    body: document.getElementById('p-body'),
    count: document.getElementById('p-count'),
    verdict: document.getElementById('p-verdict'),
  };
  for (var k in el) if (!el[k]) return;

  function gbLabel(gb) {
    if (!gb) return '0';
    if (gb >= 1024) { var t = gb / 1024; return (t % 1 ? t.toFixed(1) : t) + ' TB'; }
    return gb + ' GB';
  }
  function usd(n) {
    return n >= 1000 ? '$' + Math.round(n).toLocaleString('en-US') : '$' + n.toFixed(2);
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
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

  function effective(r, egressGb) {
    var billable = Math.max(0, egressGb - (r.included_egress_gb || 0));
    return Math.round((r.price_monthly_usd + egressCost(schedule(r.provider, r.region), billable)) * 100) / 100;
  }

  /** Ordinary monthly traffic eats the allowance first; the rest absorbs the move. */
  function exitCost(r, datasetGb, monthlyEgressGb) {
    var spare = Math.max(0, (r.included_egress_gb || 0) - monthlyEgressGb);
    return egressCost(schedule(r.provider, r.region), Math.max(0, datasetGb - spare));
  }

  function state() {
    var parts = el.shape.value.split('/');
    return {
      region: el.region.value,
      vcpu: +parts[0],
      ram: +parts[1],
      from: el.from.value,
      egressGb: EGRESS_STEPS[+el.egress.value],
      datasetGb: DATA_STEPS[+el.dataset.value],
    };
  }

  function rows(s) {
    var out = [];
    for (var i = 0; i < D.compute.length; i++) {
      var r = D.compute[i];
      if (r.region !== s.region || r.vcpu !== s.vcpu || r.ram_gb !== s.ram) continue;
      out.push({
        r: r,
        eff: effective(r, s.egressGb),
        exit: exitCost(r, s.datasetGb, s.egressGb),
      });
    }
    out.sort(function (a, b) { return a.eff - b.eff; });
    return out;
  }

  function render() {
    var s = state();
    var data = rows(s);
    el.egressLabel.textContent = gbLabel(s.egressGb);
    el.datasetLabel.textContent = gbLabel(s.datasetGb);
    el.count.textContent = String(data.length);

    // Where you are now: that provider's cheapest option at this shape.
    var current = null;
    if (s.from) {
      for (var i = 0; i < data.length; i++) {
        if (data[i].r.provider === s.from) { current = data[i]; break; }
      }
    }

    var min = data.length ? data[0].eff : null;
    var html = '';

    for (var j = 0; j < data.length; j++) {
      var d = data[j], r = d.r;
      var p = D.providers[r.provider] || { short: r.provider };
      var best = d.eff === min;
      var isCurrent = current && r === current.r;

      // Payback is charged against leaving where you are, not where you land.
      var payback = '—';
      if (current && !isCurrent) {
        var saving = current.eff - d.eff;
        if (saving > 0) {
          var toll = exitCost(current.r, s.datasetGb, s.egressGb);
          var months = toll / saving;
          payback = months < 0.1 ? 'immediate'
            : months > 240 ? 'never'
            : months.toFixed(1) + ' mo';
        } else {
          payback = '<span class="faint">costs more</span>';
        }
      }

      html +=
        '<tr class="' + (isCurrent ? 'is-current' : best ? 'is-cheapest' : '') + '">' +
        '<td data-label="Provider"><strong>' + esc(p.short) + '</strong>' +
        (isCurrent ? '<span class="chip chip-dedicated" style="margin-left:6px">you are here</span>' : '') +
        '</td>' +
        '<td class="num col-optional" data-label="Instance">' + esc(r.display_name) + '</td>' +
        '<td class="right num faint col-optional" data-label="Bundled egress">' +
        gbLabel(r.included_egress_gb) + '</td>' +
        '<td class="right num" data-label="Effective $/mo" style="font-weight:700">' + usd(d.eff) +
        (best && !isCurrent ? '<span class="chip chip-win" style="margin-left:6px">cheapest</span>' : '') +
        '</td>' +
        '<td class="right num" data-label="Cost to leave" style="color:' +
        (d.exit > 0 ? 'var(--warn)' : 'var(--win);font-weight:600') + '">' +
        (d.exit > 0 ? usd(d.exit) : 'free') + '</td>' +
        '<td class="right num faint col-optional" data-label="Months of spend">' +
        (d.eff > 0 ? (d.exit / d.eff).toFixed(1) : '—') + '</td>' +
        '<td class="right num faint" data-label="Payback">' + payback + '</td>' +
        '</tr>';
    }

    if (!data.length) {
      html = '<tr><td colspan="7" style="padding:26px;text-align:center" class="muted">' +
        'No provider offers this shape in this region. Try another size.</td></tr>';
    }
    el.body.innerHTML = html;
    renderVerdict(s, data, current);
    writeURL(s);
  }

  function renderVerdict(s, data, current) {
    if (!data.length) { el.verdict.innerHTML = ''; return; }
    var best = data[0];
    var bp = D.providers[best.r.provider] || { short: best.r.provider };
    var b = '<strong style="color:var(--fg)">';

    var html;
    if (!current) {
      html = 'Cheapest at this shape and egress volume is ' + b + esc(bp.short) + ' ' +
        esc(best.r.display_name) + '</strong> at ' + b + usd(best.eff) + '/mo</strong>. ' +
        'Leaving it later with ' + gbLabel(s.datasetGb) + ' of data would cost ' +
        b + (best.exit > 0 ? usd(best.exit) : 'nothing') + '</strong>.';
    } else if (current.r === best.r) {
      html = 'You are already on the cheapest option at this shape and volume — ' +
        b + esc(bp.short) + '</strong> at ' + b + usd(best.eff) + '/mo</strong>. ' +
        'Nothing here is worth moving for.';
    } else {
      var saving = current.eff - best.eff;
      var toll = exitCost(current.r, s.datasetGb, s.egressGb);
      var months = saving > 0 ? toll / saving : Infinity;
      var cp = D.providers[current.r.provider] || { short: current.r.provider };

      if (saving <= 0) {
        html = 'Nothing here beats ' + b + esc(cp.short) + '</strong> at ' +
          b + usd(current.eff) + '/mo</strong> for this workload. Stay put.';
      } else if (months > 36) {
        html = b + esc(bp.short) + '</strong> is ' + b + usd(saving) + '/mo</strong> cheaper, ' +
          'but leaving ' + esc(cp.short) + ' with ' + gbLabel(s.datasetGb) + ' costs ' +
          b + usd(toll) + '</strong> — ' + b + months.toFixed(0) + ' months</strong> to break even. ' +
          'The egress toll eats the saving; this is not worth doing on price alone.';
      } else {
        // With nothing to carry there is no toll to repay, so "payback" is the
        // wrong frame entirely — say so rather than reporting "under a month".
        var tollPhrase = s.datasetGb === 0
          ? 'With no data to carry, there is no exit toll at all'
          : 'Exit toll on ' + gbLabel(s.datasetGb) + ' is ' + b +
            (toll > 0 ? usd(toll) : 'nothing') + '</strong>, so it pays back in ' + b +
            (months < 0.1 ? 'under a month' : months.toFixed(1) + ' months') + '</strong>';

        html = 'Moving from ' + esc(cp.short) + ' to ' + b + esc(bp.short) + '</strong> saves ' +
          b + usd(saving) + '/mo</strong>. ' + tollPhrase + '. ' +
          '<span class="faint">Migration effort not included — see below.</span>';
      }
    }
    el.verdict.innerHTML = '<div style="font-size:13px" class="muted">' + html + '</div>';
  }

  function writeURL(s) {
    var q = new URLSearchParams();
    q.set('region', s.region);
    q.set('shape', s.vcpu + '/' + s.ram);
    q.set('egress', String(s.egressGb));
    q.set('data', String(s.datasetGb));
    if (s.from) q.set('from', s.from);
    history.replaceState(null, '', location.pathname + '?' + q.toString());
  }

  function readURL() {
    var q = new URLSearchParams(location.search);
    if (q.get('region')) el.region.value = q.get('region');
    if (q.get('shape')) el.shape.value = q.get('shape');
    if (q.get('from')) el.from.value = q.get('from');
    var e = EGRESS_STEPS.indexOf(parseInt(q.get('egress'), 10));
    if (e >= 0) el.egress.value = String(e);
    var d = DATA_STEPS.indexOf(parseInt(q.get('data'), 10));
    if (d >= 0) el.dataset.value = String(d);
  }

  ['region', 'shape', 'from'].forEach(function (n) {
    el[n].addEventListener('change', render);
  });
  el.egress.addEventListener('input', render);
  el.dataset.addEventListener('input', render);

  readURL();
  render();
})();
