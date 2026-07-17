// AI Search Visibility Report — fills the one-page print template from the
// stored analysis result, then opens the print dialog (Save as PDF).
//
// Runs as a privileged extension page (report.html). The core fillTemplate()
// is pure (no DOM / chrome APIs) so the exact same mapping can be exercised
// headlessly in Node; the browser boot path is guarded at the bottom.

(function () {
  'use strict';

  // ---- tiny templating --------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[<>&"']/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fillTokens(html, map) {
    return html.replace(/\{\{(\w+)\}\}/g, function (_, k) {
      return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : '';
    });
  }
  // Expand a <!-- BEGIN name -->…<!-- END name --> block: repeat its inner
  // markup once per item, filling that row's tokens. Emits nothing for [].
  function expandBlock(html, name, items, mapper) {
    var re = new RegExp('<!--\\s*BEGIN ' + name + '\\s*-->([\\s\\S]*?)<!--\\s*END ' + name + '\\s*-->');
    var m = html.match(re);
    if (!m) return html;
    var tpl = m[1];
    var out = items.map(function (it, i) { return fillTokens(tpl, mapper(it, i)); }).join('');
    // Function replacement inserts `out` literally — a string replacement would
    // treat `$&`, `$1`, etc. in finding text as special patterns.
    return html.replace(re, function () { return out; });
  }

  // ---- lookups & formatting --------------------------------------------
  var SEG = {
    fully_accessible:     ['seg-good', 'Fully Visible'],
    mostly_visible:       ['seg-good', 'Mostly Visible'],
    partially_accessible: ['seg-warn', 'Partially Visible'],
    slipping:             ['seg-warn', 'Half Visible'],
    js_dependent:         ['seg-bad',  'Barely Visible'],
    invisible:            ['seg-invisible', 'Invisible']
  };
  // Deterministic verdict prose — one variant per visibility segment. Authored
  // once (design time); never generated at runtime, so numbers can't drift.
  var VERDICT = {
    fully_accessible: {
      head: 'AI search engines can read this page.',
      body: 'The crawlers behind ChatGPT, Claude, and Perplexity read your server HTML <em>before</em> JavaScript runs. On this page they see the same content your visitors do.'
    },
    mostly_visible: {
      head: 'AI search engines read almost all of this page.',
      body: 'The crawlers behind ChatGPT, Claude, and Perplexity read your server HTML <em>before</em> JavaScript runs. They pick up most of your content here. A few parts still load later with JavaScript.'
    },
    partially_accessible: {
      head: 'AI search engines miss part of this page.',
      body: 'The crawlers behind ChatGPT, Claude, and Perplexity read your server HTML <em>before</em> JavaScript runs. Some of your content only appears after JavaScript loads, so it never reaches an AI answer.'
    },
    slipping: {
      head: 'Half of this page is invisible to AI search.',
      body: 'The crawlers behind ChatGPT, Claude, and Perplexity read your server HTML <em>before</em> JavaScript runs. They see about half of what your visitors see. The rest loads too late to be indexed.'
    },
    js_dependent: {
      head: 'Most of this page is invisible to AI search engines.',
      body: 'The crawlers behind ChatGPT, Claude, and Perplexity read your server HTML <em>before</em> JavaScript runs. They see only a small part of your page. The rest never makes it into an AI answer.'
    },
    invisible: {
      head: 'AI search engines see almost nothing on this page.',
      body: 'The crawlers behind ChatGPT, Claude, and Perplexity read your server HTML <em>before</em> JavaScript runs. Your server sends almost no readable text, so AI tools have nothing to cite.'
    }
  };
  var SEV = { high: ['sev-high', 'High'], medium: ['sev-med', 'Med'], low: ['sev-low', 'Low'] };
  var SEV_ORDER = { high: 0, medium: 1, low: 2 };
  var BD_LABELS = {
    serverVisibility: 'Server visibility',
    crawlerAccess: 'Crawler access',
    structuredData: 'Structured data',
    robotsRestrictions: 'Robots OK'
  };
  var BD_ORDER = ['serverVisibility', 'crawlerAccess', 'structuredData', 'robotsRestrictions'];

  function classForScore(v) {
    if (v == null) return 'unknown';
    return v >= 80 ? 'good' : v >= 50 ? 'warn' : 'bad';
  }
  function classForRatio(r) {
    if (r == null) return '';
    return r >= 0.8 ? 'good' : r >= 0.5 ? 'warn' : 'bad';
  }
  function clampPct(n) { return Math.max(0, Math.min(100, n)); }
  function fmtMs(ms) { return ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(2) + 's'; }
  function sevRank(s) { return SEV_ORDER[s] == null ? 3 : SEV_ORDER[s]; }
  function hostOf(url) { try { return new URL(url).host; } catch (e) { return ''; } }
  function pathOf(url) { try { var u = new URL(url); return u.host + u.pathname; } catch (e) { return url || ''; } }
  function joinNames(a) {
    if (a.length === 1) return a[0];
    if (a.length === 2) return a[0] + ' & ' + a[1];
    return a.slice(0, -1).join(', ') + ' & ' + a[a.length - 1];
  }
  function formatDate(ts) {
    var d = ts ? new Date(ts) : new Date();
    try { return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch (e) { return ''; }
  }

  // ---- derived fields ---------------------------------------------------
  function visibilityValue(r) {
    var s = r.server || {};
    if (s.fetched && typeof s.textRatio === 'number') {
      var overlap = typeof s.contentOverlap === 'number' ? s.contentOverlap : s.textRatio;
      return Math.round(Math.min(s.textRatio, overlap) * 100) + '%';
    }
    if (typeof r.score === 'number') return String(r.score);
    return '—';
  }
  function buildSignals(r) {
    var out = [];
    var s = r.server || {};
    if (s.fetched && typeof s.textRatio === 'number') {
      out.push({ cls: classForRatio(s.textRatio), val: Math.round(s.textRatio * 100) + '%', label: 'Text length in server HTML' });
    }
    if (s.fetched && typeof s.contentOverlap === 'number') {
      out.push({ cls: classForRatio(s.contentOverlap), val: Math.round(s.contentOverlap * 100) + '%', label: 'Word overlap with rendered' });
    }
    var p = r.performance || {};
    if (typeof p.ttfbMs === 'number') {
      out.push({ cls: p.ttfbMs < 1000 ? 'good' : p.ttfbMs < 2000 ? 'warn' : 'bad', val: fmtMs(p.ttfbMs), label: 'Time to first byte' });
    }
    var load = p.loadCompleteMs || p.lcpMs;
    if (typeof load === 'number') {
      out.push({ cls: load < 2000 ? 'good' : load < 4000 ? 'warn' : 'bad', val: (load / 1000).toFixed(1) + 's', label: 'Full page load' });
    }
    return out.slice(0, 4);
  }
  function crawlerNote(r) {
    var probes = r.botProbes;
    if (probes && probes.enabled && probes.results && probes.results.length) {
      var pick = function (statuses) {
        return probes.results.filter(function (x) { return statuses.indexOf(x.status) !== -1; })
          .map(function (x) { return x.name; });
      };
      var blocked = pick(['blocked', 'challenged']);
      var less = pick(['served_less']);
      var dyn = pick(['dynamic_rendering']);
      if (blocked.length) return esc(joinNames(blocked)) + ' ' + (blocked.length > 1 ? 'were' : 'was') + ' <strong>blocked or challenged</strong> when probing as an AI crawler.';
      if (less.length) return esc(joinNames(less)) + ' ' + (less.length > 1 ? 'were' : 'was') + ' served <strong>less content</strong> than your visitors.';
      if (dyn.length) return esc(joinNames(dyn)) + ' received <strong>extra server-rendered content</strong> (dynamic rendering).';
      return 'Every probed crawler received the <strong>same content</strong> as your visitors.';
    }
    // Probe toggle off — fall back to a robots.txt-based summary.
    var c = r.crawlers || {};
    if (!c.fetched) return 'robots.txt was unreachable, so crawler access could not be confirmed.';
    var bots = c.bots || [];
    var blockedBots = bots.filter(function (b) { return b.status === 'blocked'; });
    if (!blockedBots.length) return 'All major AI crawlers are <strong>allowed</strong> by robots.txt.';
    return blockedBots.length + ' of ' + bots.length + ' AI crawlers are <strong>blocked</strong> by robots.txt.';
  }

  // ---- the pure fill ----------------------------------------------------
  // Takes the template markup + { results, url } and returns filled markup.
  function fillTemplate(html, payload) {
    var r = (payload && payload.results) || {};
    var url = (payload && payload.url) || '';
    var host = hostOf(url);

    var segKey = SEG[r.segment] ? r.segment
      : (typeof r.score === 'number' && r.score < 50 ? 'js_dependent' : 'partially_accessible');
    var seg = SEG[segKey];
    var verdict = VERDICT[segKey] || VERDICT.partially_accessible;
    var ctaUrl = 'https://www.alliai.com/?source=extension&website=' + encodeURIComponent(host || 'unknown');

    // Repeat blocks first (each contains its own row tokens).
    var issues = (r.issues || []).slice()
      .sort(function (a, b) { return sevRank(a.severity) - sevRank(b.severity); })
      .slice(0, 5);
    html = expandBlock(html, 'issues', issues, function (it) {
      var sv = SEV[it.severity] || SEV.low;
      return { ISSUE_SEV_CLASS: sv[0], ISSUE_SEV_LABEL: sv[1], ISSUE_TITLE: esc(it.message), ISSUE_IMPACT: esc(it.impact || '') };
    });

    var fixes = (r.recommendations || []).slice(0, 4);
    html = expandBlock(html, 'fixes', fixes, function (it, i) {
      return { FIX_NUM: String(i + 1), FIX_TITLE: esc(it.action), FIX_DESC: esc(it.description || '') };
    });

    var bd = r.scoreBreakdown || {};
    var bdItems = BD_ORDER.filter(function (k) { return k in bd; }).map(function (k) { return { key: k, val: bd[k] }; });
    html = expandBlock(html, 'breakdown', bdItems, function (it) {
      var v = it.val;
      return {
        BD_CLASS: classForScore(v),
        BD_LABEL: BD_LABELS[it.key] || it.key,
        BD_VALUE: v == null ? '—' : String(v),
        BD_PCT: String(v == null ? 0 : clampPct(v))
      };
    });

    var signals = buildSignals(r);
    html = expandBlock(html, 'signals', signals, function (it) {
      return { SIGNAL_CLASS: it.cls, SIGNAL_VALUE: esc(it.val), SIGNAL_LABEL: esc(it.label) };
    });

    var bots = (r.crawlers && r.crawlers.bots) || [];
    html = expandBlock(html, 'crawler_dots', bots, function (b) {
      return { DOT_CLASS: b.status === 'allowed' ? 'allowed' : b.status === 'blocked' ? 'blocked' : '' };
    });

    var files = r.aiSearchFiles || {};
    var fileItems = [
      { name: 'sitemap.xml', present: !!(files.sitemapPresent || files.sitemapDeclared) },
      { name: 'llms.txt', present: !!files.llmsTxtPresent }
    ];
    html = expandBlock(html, 'files', fileItems, function (it) {
      return { FILE_CLASS: it.present ? 'present' : 'absent', FILE_NAME: it.name };
    });

    var allowedCount = bots.filter(function (b) { return b.status === 'allowed'; }).length;

    // Scalars last.
    return fillTokens(html, {
      PAGE_URL: esc(pathOf(url)),
      DATE: formatDate(r.timestamp),
      SEGMENT_CLASS: seg[0],
      VISIBILITY_PCT: esc(visibilityValue(r)),
      SEGMENT_LABEL: esc(seg[1]),
      VERDICT_HEADLINE: verdict.head,
      VERDICT_BODY: verdict.body,
      ISSUE_COUNT: String((r.issues || []).length),
      CRAWLER_ALLOWED: String(allowedCount),
      CRAWLER_TOTAL: String(bots.length || 12),
      CRAWLER_NOTE: crawlerNote(r),
      CTA_URL: esc(ctaUrl)
    });
  }

  // Node export — lets the mapping be verified headlessly.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { fillTemplate: fillTemplate };
  }

  // ---- browser boot -----------------------------------------------------
  if (typeof document === 'undefined') return;

  var STORAGE_KEY = 'report:pending';

  function showError(msg) {
    var root = document.querySelector('.sheet');
    if (root) {
      root.innerHTML = '<div style="margin:auto;padding:80px 40px;text-align:center;color:#626262;' +
        'font:600 15px/1.5 var(--font-sans);">' + esc(msg) + '</div>';
    }
  }

  function render(payload) {
    var root = document.querySelector('.sheet');
    if (!root) return;
    root.innerHTML = fillTemplate(root.innerHTML, payload);
    var host = hostOf((payload && payload.url) || '');
    document.title = 'AI Search Visibility Report - ' + (host || 'report');
  }

  function boot() {
    var printBtn = document.getElementById('print-btn');
    if (printBtn) printBtn.addEventListener('click', function () { window.print(); });

    if (!(window.chrome && chrome.storage && chrome.storage.session)) {
      showError('No report data available.');
      return;
    }
    chrome.storage.session.get(STORAGE_KEY).then(function (obj) {
      var payload = obj && obj[STORAGE_KEY];
      if (!payload) {
        showError('No report data available. Reopen the extension on the page you want to report on.');
        return;
      }
      try { render(payload); }
      catch (e) { console.error(e); showError('Could not render the report.'); return; }
      chrome.storage.session.remove(STORAGE_KEY);
      // Let the bundled font + layout settle, then open the print dialog.
      setTimeout(function () { window.print(); }, 400);
    }).catch(function (e) { console.error(e); showError('Could not read report data.'); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
