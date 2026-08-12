/**
 * Egress table island. Both tables are fully server-rendered; this only
 * re-sorts and re-highlights when a volume preset is chosen, so the page works
 * without JS and the selection survives a reload via the URL.
 *
 * Compute and object-storage providers are sorted independently — they are
 * never ranked against each other, because they are not substitutes.
 */
(function () {
  var D = window.__RCE__;
  if (!D || !D.groups) return;

  var buttons = [].slice.call(document.querySelectorAll('.preset[data-vol]'));
  if (!buttons.length) return;

  var active = 1024;

  function gbLabel(gb) {
    if (!gb) return '0';
    if (gb >= 1024) {
      var t = gb / 1024;
      return (t % 1 ? t.toFixed(1) : t) + ' TB';
    }
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

  function renderGroup(group, idx) {
    var body = document.querySelector('[data-group-body="' + group.id + '"]');
    if (!body) return;

    var rows = group.rows.slice().sort(function (a, b) {
      return a.costs[idx] - b.costs[idx];
    });
    // Cheapest is per group; a storage service does not "win" the compute table.
    var min = rows.reduce(function (m, r) {
      return Math.min(m, r.costs[idx]);
    }, Infinity);

    var html = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var headline =
        r.headline === 0
          ? '<span style="color:var(--win);font-weight:700">free</span>'
          : '$' + String(r.headline.toFixed(5)).replace(/0+$/, '').replace(/\.$/, '');

      var bundled = r.bundled ? 'per plan' : r.free ? gbLabel(r.free) : '—';
      var unverified =
        r.confidence !== 'high' && !r.verified
          ? '<span class="chip chip-unverified" style="margin-left:6px">unverified</span>'
          : '';
      var verified =
        r.confidence === 'high'
          ? '<span title="Collected from the provider\'s own API">live API</span>'
          : r.verified || '—';

      var cells = '';
      for (var v = 0; v < r.costs.length; v++) {
        var c = r.costs[v];
        cells +=
          '<td class="right num vol-col' +
          (D.volumes[v] === active ? ' col-active' : '') +
          '" data-vol="' + D.volumes[v] + '" data-label="' + gbLabel(D.volumes[v]) + '/mo"' +
          (c === 0 ? ' style="color:var(--win);font-weight:600"' : '') + '>' +
          (c === 0 ? 'free' : usd(c)) +
          '</td>';
      }

      html +=
        '<tr class="' + (r.costs[idx] === min ? 'is-cheapest' : '') + '">' +
        '<td data-label="Provider"><strong>' + esc(r.short) + '</strong>' + unverified + '</td>' +
        '<td class="right num col-optional" data-label="First paid GB">' + headline + '</td>' +
        '<td class="right num faint" data-label="Free / bundled">' + bundled + '</td>' +
        cells +
        '<td class="col-optional faint" data-label="Verified" style="font-size:12px">' + verified + '</td>' +
        '<td data-label="Source"><a href="' + esc(r.source_url) + '" rel="nofollow noopener" target="_blank" ' +
        'class="faint" style="font-size:12px">source ↗</a></td>' +
        '</tr>';
    }
    body.innerHTML = html;
  }

  function render() {
    var idx = D.volumes.indexOf(active);
    if (idx < 0) idx = D.volumes.indexOf(1024);

    D.groups.forEach(function (g) {
      renderGroup(g, idx);
    });

    // Header highlight has to move in every table, or the sorted column is
    // ambiguous in whichever one was not updated.
    var ths = document.querySelectorAll('.egress-grid thead th.vol-col');
    for (var h = 0; h < ths.length; h++) {
      ths[h].classList.toggle('col-active', +ths[h].dataset.vol === active);
    }
    buttons.forEach(function (b) {
      b.setAttribute('aria-pressed', +b.dataset.vol === active ? 'true' : 'false');
    });

    var q = new URLSearchParams(location.search);
    q.set('at', String(active));
    history.replaceState(null, '', location.pathname + '?' + q.toString());
  }

  buttons.forEach(function (b) {
    b.addEventListener('click', function () {
      active = +b.dataset.vol;
      render();
    });
  });

  var initial = parseInt(new URLSearchParams(location.search).get('at'), 10);
  if (D.volumes.indexOf(initial) >= 0) {
    active = initial;
    render();
  }
})();
