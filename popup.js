// AI Search Visibility Checker — Popup Script

// ----------------------------------------------------------------------------
// TooltipManager — one shared tooltip, positioned by JS to fit the popup.
//
// Pseudo-element tooltips on each trigger can't see the popup's bounds, so
// they overflow when the trigger is near an edge. This class places a single
// fixed-position element, measures the popup's actual viewport, and clamps
// the tooltip's coordinates to stay inside.
// ----------------------------------------------------------------------------
class TooltipManager {
  constructor() {
    this.el = document.getElementById('global-tooltip');
    if (!this.el) return;

    // Event delegation — works for elements rendered later. Use mouseover/
    // mouseout (which bubble) with relatedTarget checks so we don't churn
    // when the cursor moves between a trigger's child nodes.
    document.addEventListener('mouseover', (e) => this.handlePointer(e, true));
    document.addEventListener('mouseout',  (e) => this.handlePointer(e, false));
    document.addEventListener('focusin',   (e) => this.handlePointer(e, true));
    document.addEventListener('focusout',  (e) => this.handlePointer(e, false));
    // Hide on any scroll — tooltip position would be stale.
    window.addEventListener('scroll', () => this.hide(), true);
  }

  handlePointer(event, show) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const trigger = target.closest('[data-tooltip]');
    if (!trigger) return;
    // Ignore intra-trigger moves: if the cursor is still within the same
    // trigger (just over a different descendant), don't toggle.
    if (event.relatedTarget && trigger.contains(event.relatedTarget)) return;
    if (show) this.show(trigger);
    else this.hide();
  }

  show(trigger) {
    if (!this.el) return;
    const text = trigger.getAttribute('data-tooltip');
    if (!text) return;
    this.el.textContent = text;
    this.el.style.display = 'block';
    this.position(trigger);
  }

  hide() {
    if (!this.el) return;
    this.el.style.display = 'none';
  }

  position(trigger) {
    const trig = trigger.getBoundingClientRect();
    const tip = this.el.getBoundingClientRect();
    const W = document.documentElement.clientWidth;
    const H = document.documentElement.clientHeight;
    const GAP = 6;
    const PAD = 8;

    // Vertical: prefer above unless the trigger says otherwise; flip if it
    // doesn't fit on the preferred side.
    const preferBelow = trigger.getAttribute('data-tooltip-pos') === 'below';
    let top;
    if (preferBelow) {
      top = trig.bottom + GAP;
      if (top + tip.height > H - PAD) top = trig.top - tip.height - GAP;
    } else {
      top = trig.top - tip.height - GAP;
      if (top < PAD) top = trig.bottom + GAP;
    }
    top = Math.max(PAD, Math.min(top, H - tip.height - PAD));

    // Horizontal: center on the trigger, then clamp inside the popup.
    let left = trig.left + (trig.width / 2) - (tip.width / 2);
    if (left < PAD) left = PAD;
    if (left + tip.width > W - PAD) left = W - PAD - tip.width;

    this.el.style.top = `${top}px`;
    this.el.style.left = `${left}px`;
  }
}

class PopupManager {
  constructor() {
    this.loadingEl = document.getElementById('loading');
    this.resultsEl = document.getElementById('results');
    this.pageUrlEl = document.getElementById('page-url');
    this.pageUrlPathEl = document.getElementById('page-url-path');

    this.scoreEl = document.getElementById('score');
    this.scoreDescEl = document.getElementById('score-description');
    this.segmentChipEl = document.getElementById('segment-chip');
    this.signalsEl = document.getElementById('signals');

    this.breakdownSectionEl = document.getElementById('breakdown-section');
    this.breakdownListEl = document.getElementById('breakdown-list');

    this.crawlersSectionEl = document.getElementById('crawlers-section');
    this.crawlerGridEl = document.getElementById('crawler-grid');
    this.aiFilesRowEl = document.getElementById('ai-files-row');

    this.botProbesSectionEl = document.getElementById('bot-probes-section');
    this.botProbesListEl = document.getElementById('bot-probes-list');
    this.botProbesBaselineEl = document.getElementById('bot-probes-baseline');

    this.probeToggleEl = document.getElementById('probe-toggle');

    this.issuesSectionEl = document.getElementById('issues-section');
    this.issuesListEl = document.getElementById('issues-list');

    this.recsSectionEl = document.getElementById('recommendations-section');
    this.recsListEl = document.getElementById('recommendations-list');

    this.postHydrationNoticeEl = document.getElementById('post-hydration-notice');
    this.primaryCtaBtn = document.getElementById('primary-cta-btn');
    this.downloadReportBtn = document.getElementById('download-report-btn');

    this.init();
  }

  async init() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    this.currentTabId = tabs[0] && tabs[0].id;
    this.setHeader(tabs[0] && tabs[0].url);
    this.pageUrl = tabs[0] && tabs[0].url;

    // Epoch counter — bumped whenever we invalidate the current load (e.g.
    // user flipped a setting). In-flight loadResults checks before rendering.
    this.epoch = 0;

    this.primaryCtaBtn.addEventListener('click', () => this.handlePrimaryCTA());

    if (this.downloadReportBtn) {
      this.downloadReportBtn.addEventListener('click', () => this.handleDownloadReport());
    }

    // V2 settings — read current value, then wire up the change handler.
    await this.initProbeToggle();

    this.showLoadingState();
    const started = await this.startReloadAnalysis();
    if (!started) {
      this.showErrorState('This page can’t be analyzed. Chrome’s internal pages and the Web Store block extensions.');
      return;
    }
    this.loadResults();
  }

  async initProbeToggle() {
    if (!this.probeToggleEl) return;
    try {
      // Default is ON — must match the content-script fallback in content.js.
      const { probeAsAiCrawlers = true } = await chrome.storage.local.get('probeAsAiCrawlers');
      this.probeToggleEl.checked = !!probeAsAiCrawlers;
    } catch (_) { this.probeToggleEl.checked = true; }

    this.probeToggleEl.addEventListener('change', async () => {
      const enabled = this.probeToggleEl.checked;
      try {
        await chrome.storage.local.set({ probeAsAiCrawlers: enabled });
      } catch (_) { /* ignore */ }

      // Invalidate any in-flight loadResults; clear cache; re-inject.
      this.epoch++;
      this.showLoadingState();
      this.retryCount = 0;
      this.injectionAttempts = 0;
      try {
        await chrome.runtime.sendMessage({
          type: 'CLEAR_ANALYSIS',
          tabId: this.currentTabId
        });
      } catch (_) { /* ignore */ }
      const ok = await this.triggerNewAnalysis();
      if (!ok) {
        this.showErrorState('Couldn’t re-run analysis on this page.');
        return;
      }
      this.injectionAttempts = 1;
      this.loadResults();
    });
  }

  showLoadingState() {
    if (this.loadingEl) this.loadingEl.style.display = 'block';
    if (this.resultsEl) this.resultsEl.style.display = 'none';
  }

  setHeader(url) {
    if (!this.pageUrlPathEl || !url) return;
    try {
      const u = new URL(url);
      // host + path so users see the scope: one page, not the whole site.
      // Protocol stripped for readability. The "Just this page:" label is
      // static in the HTML; we only fill in the URL part here.
      let display = u.host + u.pathname;
      if (u.search) display += u.search;
      this.pageUrlPathEl.textContent = display;
      if (this.pageUrlEl) {
        this.pageUrlEl.setAttribute('data-tooltip', url);
        this.pageUrlEl.setAttribute('data-tooltip-pos', 'below');
      }
    } catch (_) {
      this.pageUrlPathEl.textContent = '';
    }
  }

  async loadResults() {
    if (this.retryCount === undefined) this.retryCount = 0;
    if (this.injectionAttempts === undefined) this.injectionAttempts = 0;

    const myEpoch = this.epoch;

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'GET_ANALYSIS',
        tabId: this.currentTabId
      });
    } catch (_) {
      response = null;
    }

    // Bail if a setting flip invalidated this load while we were waiting.
    if (myEpoch !== this.epoch) return;

    if (response && response.type === 'ok' && response.results) {
      this.displayResults(response.results);
      return;
    }

    if (response && response.type === 'error') {
      this.showErrorState(response.error);
      return;
    }

    this.retryCount++;

    // Analysis starts at popup-open via a reload request, or via explicit
    // re-run paths (like settings changes). This loop just polls for the result.
    const GIVE_UP_AFTER = 60; // ~30s total polling budget

    if (this.injectionAttempts === 0) {
      this.injectionAttempts = 1;
    } else if (this.retryCount >= GIVE_UP_AFTER) {
      this.showErrorState('Analysis timed out. Try refreshing the page.');
      return;
    }

    setTimeout(() => this.loadResults(), 500);
  }

  async triggerNewAnalysis() {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: this.currentTabId },
        func: () => { window.aiSearchVisibilityCheckerLoaded = false; }
      });
      await chrome.scripting.executeScript({
        target: { tabId: this.currentTabId },
        files: ['content.js']
      });
      return true;
    } catch (error) {
      console.error('Failed to trigger new analysis:', error);
      return false;
    }
  }

  async startReloadAnalysis() {
    this.retryCount = 0;
    this.injectionAttempts = 1;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'START_RELOAD_ANALYSIS',
        tabId: this.currentTabId
      });
      return !!(response && response.success);
    } catch (_) {
      return false;
    }
  }

  showErrorState(message) {
    this.loadingEl.style.display = 'none';
    const safe = this.escape(message || 'Can’t analyze this page.');
    this.resultsEl.innerHTML = `
      <div class="error-state">
        <div class="error-state-title">${safe}</div>
        <div class="error-state-detail">Refresh the page and reopen the extension.</div>
      </div>
    `;
    this.resultsEl.style.display = 'block';
  }

  displayResults(results) {
    this.loadingEl.style.display = 'none';
    this.resultsEl.style.display = 'block';

    this.lastResults = results;

    this.renderHero(results);
    this.renderSegment(results.segment);
    this.renderSignals(results);
    this.renderBreakdown(results.scoreBreakdown);

    if (results.crawlers) {
      this.renderCrawlers(results.crawlers, results.aiSearchFiles);
    }

    if (results.botProbes && results.botProbes.enabled) {
      this.renderBotProbes(results.botProbes, results.server);
    }

    if (results.issues && results.issues.length > 0) {
      this.issuesSectionEl.style.display = 'block';
      this.renderIssues(results.issues);
    }

    if (results.recommendations && results.recommendations.length > 0) {
      this.recsSectionEl.style.display = 'block';
      this.renderRecommendations(results.recommendations);
    }

    if (results.postHydration) {
      this.renderPostHydrationNotice();
    }

  }

  // ---------- Score / status ----------

  // Hero rendering — one number, one color, one description.
  //
  // The headline is the visibility % (textRatio * 100) rather than the
  // synthesized score. The score is capped by visibility so they match
  // in most cases — showing both was the redundancy the user flagged
  // ("100 and 100% feels repeating"). Lead with the concrete metric.
  //
  // When the server fetch failed, fall back to the score number so the
  // hero still has a value to show.
  renderHero(results) {
    if (!this.scoreEl) return;
    this.scoreEl.classList.remove('good', 'warn', 'bad', 'invisible');
    if (this.scoreDescEl) {
      this.scoreDescEl.classList.remove('good', 'warn', 'bad', 'invisible');
      this.scoreDescEl.textContent = '';
    }

    const server = results.server;
    const segment = results.segment;
    const visibilityKnown = server && server.fetched && typeof server.textRatio === 'number';

    // 1. Big number — MIN of text length and word overlap.
    //
    // Why MIN: the segment chip uses AND logic (both metrics must clear a
    // threshold). A site with 100% text length but 20% word overlap (content
    // drift, personalized swaps, partial cloaking) is correctly labeled
    // "Hidden from AI" by the segment but would be misleadingly labeled
    // "100% visible" if we just used text length. MIN makes the headline
    // agree with the verdict.
    if (visibilityKnown) {
      const overlap = typeof server.contentOverlap === 'number'
        ? server.contentOverlap
        : server.textRatio;
      const visibility = Math.min(server.textRatio, overlap);
      this.scoreEl.textContent = `${Math.round(visibility * 100)}%`;
    } else if (typeof results.score === 'number') {
      // Visibility unavailable (fetch failed) — fall back to the score.
      this.scoreEl.textContent = String(results.score);
    } else {
      this.scoreEl.textContent = '—';
    }

    // 2. Color class — driven by segment when known, by score otherwise.
    let cls = '';
    if (segment && segment !== 'unknown') {
      cls = {
        fully_accessible:     'good',
        mostly_visible:       'good',
        partially_accessible: 'warn',
        slipping:             'warn',
        js_dependent:         'bad',
        invisible:            'invisible'
      }[segment] || '';
    } else if (typeof results.score === 'number') {
      cls = results.score >= 80 ? 'good' : results.score >= 50 ? 'warn' : 'bad';
    }
    if (cls) this.scoreEl.classList.add(cls);

    // 3. Status-aware description — only when there's something actionable.
    // Fully visible and mostly visible skip it (chip says it).
    const desc = {
      partially_accessible: 'Some content is invisible to bots.',
      slipping:             'About half the content is invisible to bots.',
      js_dependent:         'Most of the page is invisible to bots.',
      invisible:            'Bots see almost nothing here.'
    }[segment];
    if (this.scoreDescEl && desc) {
      this.scoreDescEl.textContent = desc;
      if (cls === 'invisible' || cls === 'bad') {
        this.scoreDescEl.classList.add(cls);
      }
    }

    // Tooltip on the number — explains why MIN.
    if (visibilityKnown) {
      this.scoreEl.setAttribute(
        'data-tooltip',
        'The lower of two measurements: how much page text is in the server response, and how much of it matches the rendered page word-for-word. Bots without JavaScript see only the server response.'
      );
      this.scoreEl.setAttribute('data-tooltip-pos', 'below');
    } else {
      this.scoreEl.removeAttribute('data-tooltip');
    }
  }

  renderSignals(results) {
    // Signal pills sit just under the score at the top of the popup —
    // tooltips need to position BELOW or they'll clip out of the popup.
    const pills = [];
    const server = results.server;
    if (server && server.fetched) {
      // Hero shows MIN(textRatio, contentOverlap) — these pills break out the
      // two underlying metrics for diagnostic detail.
      const ratioPct = Math.round((server.textRatio != null ? server.textRatio : 0) * 100);
      pills.push(`<span class="signal-pill" data-tooltip="How much page text is in the server response, vs the rendered DOM." data-tooltip-pos="below">Text length <strong>${ratioPct}%</strong></span>`);
      if (typeof server.contentOverlap === 'number') {
        const overlapPct = Math.round(server.contentOverlap * 100);
        pills.push(`<span class="signal-pill" data-tooltip="Word-level similarity between the server response and the rendered page. Low overlap with high text length means the words differ even though the lengths match." data-tooltip-pos="below">Word overlap <strong>${overlapPct}%</strong></span>`);
      }
    }
    const ttfb = results.performance && results.performance.ttfbMs;
    if (ttfb != null) {
      const fmt = ttfb < 1000 ? `${ttfb}ms` : `${(ttfb / 1000).toFixed(2)}s`;
      pills.push(`<span class="signal-pill" data-tooltip="Time to first byte. How fast the server starts responding. Crawlers with 2s budgets quit on slow first bytes." data-tooltip-pos="below">TTFB <strong>${fmt}</strong></span>`);
    }
    // Load speed pill — also displays the multiplicative score penalty when
    // the page takes longer than 2s to finish loading.
    const loadMs = results.performance && (results.performance.loadCompleteMs || results.performance.lcpMs);
    if (loadMs != null) {
      const loadSec = loadMs / 1000;
      const penalty = typeof results.loadSpeedPenalty === 'number' ? results.loadSpeedPenalty : 0;
      const penaltyTip = penalty > 0
        ? ` Above 2s the score gets a ${Math.round(penalty * 100)}% penalty.`
        : ' Anything under 2s gets no penalty.';
      pills.push(`<span class="signal-pill" data-tooltip="Time until the page finishes loading. Aim for under 2s.${penaltyTip}" data-tooltip-pos="below">Load speed <strong>${loadSec.toFixed(1)}s</strong></span>`);
    }
    if (pills.length > 0) {
      this.signalsEl.innerHTML = pills.join('');
      this.signalsEl.style.display = 'flex';
    }
  }

  renderSegment(segment) {
    if (!this.segmentChipEl || !segment || segment === 'unknown') return;
    // Visibility spectrum — 6 tiers, color signals severity bracket and the
    // text differentiates within the bracket.
    const labels = {
      fully_accessible:     'Fully Visible',
      mostly_visible:       'Mostly Visible',
      partially_accessible: 'Partially Visible',
      slipping:             'Half Visible',
      js_dependent:         'Barely Visible',
      invisible:            'Invisible'
    };
    const cls = {
      fully_accessible:     'good',
      mostly_visible:       'good',
      partially_accessible: 'warn',
      slipping:             'warn',
      js_dependent:         'bad',
      invisible:            'invisible'
    }[segment];
    const tooltip = {
      fully_accessible:     'Content visible ≥ 90%. Bots see the same content as users.',
      mostly_visible:       'Content visible 80–90%. Bots see almost everything.',
      partially_accessible: 'Content visible 65–80%. Some content is invisible to bots.',
      slipping:             'Content visible 50–65%. About half the content is invisible to bots.',
      js_dependent:         'Content visible 25–50%. Most of the page is invisible to bots.',
      invisible:            'Content visible < 25%. Bots see almost nothing here.'
    }[segment];
    if (!labels[segment] || !cls) return;
    this.segmentChipEl.className = `segment-chip ${cls}`;
    this.segmentChipEl.textContent = labels[segment];
    if (tooltip) {
      this.segmentChipEl.setAttribute('data-tooltip', tooltip);
      this.segmentChipEl.setAttribute('data-tooltip-pos', 'below');
    }
    this.segmentChipEl.style.display = 'inline-flex';
  }


  // ---------- Breakdown ----------

  renderBreakdown(breakdown) {
    if (!breakdown) return;
    const labels = {
      serverVisibility: 'Server visibility',
      crawlerAccess: 'Crawler access',
      structuredData: 'Structured data',
      robotsRestrictions: 'Robots OK'
    };
    const tooltips = {
      serverVisibility: 'Blends text length (60%) and word overlap (40%). 100 means the server matches the rendered page.',
      crawlerAccess: 'Share of 12 AI crawlers (GPTBot, ClaudeBot, PerplexityBot, etc.) allowed by robots.txt for this page.',
      structuredData: 'JSON-LD or microdata (60), sitemap.xml (25), llms.txt (15). Helps crawlers identify the page.',
      robotsRestrictions: '100 unless noindex or nofollow is set.'
    };
    const order = ['serverVisibility', 'crawlerAccess', 'structuredData', 'robotsRestrictions'];
    const rows = order.map((k) => {
      const v = breakdown[k];
      const display = v == null ? '—' : `${v}`;
      const cls = v == null ? 'unknown' : v >= 80 ? 'good' : v >= 50 ? 'warn' : 'bad';
      const width = v == null ? 0 : Math.max(2, v);
      const tip = tooltips[k] ? ` data-tooltip="${this.escape(tooltips[k])}"` : '';
      return `
        <div class="breakdown-row"${tip}>
          <div class="breakdown-label">${labels[k]}</div>
          <div class="breakdown-bar"><div class="breakdown-fill ${cls}" style="width:${width}%"></div></div>
          <div class="breakdown-value">${display}</div>
        </div>`;
    }).join('');
    this.breakdownListEl.innerHTML = rows;
    this.breakdownSectionEl.style.display = 'block';
  }

  // ---------- Crawlers ----------

  renderCrawlers(crawlers, files) {
    if (!crawlers || !crawlers.bots || crawlers.bots.length === 0) return;
    const statusLabel = {
      allowed: 'Allowed',
      partial: 'Partial',
      blocked: 'Blocked',
      unknown: 'Unknown'
    };
    const html = crawlers.bots.map((b) => {
      const parts = [statusLabel[b.status] || 'Unknown'];
      if (b.purpose) parts.push(b.purpose);
      if (b.matchedRule) parts.push(`Rule: Disallow: ${b.matchedRule}`);
      const tip = parts.join(' · ');
      return `
      <div class="crawler-row" data-tooltip="${this.escape(tip)}">
        <span class="crawler-dot ${b.status}"></span>
        <span class="crawler-name">${this.escape(b.name)}</span>
        <span class="crawler-vendor">${this.escape(b.vendor)}</span>
      </div>`;
    }).join('');
    this.crawlerGridEl.innerHTML = html;

    if (!crawlers.fetched) {
      this.aiFilesRowEl.textContent = 'robots.txt unreachable. Crawler status unknown.';
    } else {
      const sitemapPresent = !!(files && (files.sitemapPresent || files.sitemapDeclared));
      const llmsPresent = !!(files && files.llmsTxtPresent);
      this.aiFilesRowEl.innerHTML = `
        <span class="file-status">
          <span class="file-dot ${sitemapPresent ? 'present' : 'absent'}"></span>
          sitemap.xml
        </span>
        <span class="file-status">
          <span class="file-dot ${llmsPresent ? 'present' : 'absent'}"></span>
          llms.txt
        </span>
      `;
    }
    this.crawlersSectionEl.style.display = 'block';
  }

  // ---------- Bot probes (V2) ----------

  renderBotProbes(probes, server) {
    if (!this.botProbesSectionEl || !probes || !probes.results || probes.results.length === 0) return;

    const verdictByStatus = {
      no_cloaking:        { dot: 'good',    label: 'No cloaking' },
      dynamic_rendering:  { dot: 'good',    label: 'Dynamic rendering ↑' },
      served_less:        { dot: 'warn',    label: 'Served less content' },
      challenged:         { dot: 'bad',     label: 'Challenge page' },
      blocked:            { dot: 'bad',     label: 'Blocked' },
      fetch_failed:       { dot: 'unknown', label: 'Fetch failed' },
      unknown:            { dot: 'unknown', label: '—' }
    };

    const explainStatus = {
      no_cloaking:       'Bot and Chrome see the same content.',
      dynamic_rendering: 'Bot sees more content than Chrome. The server is rendering for crawlers (good).',
      served_less:       'Bot received a smaller or different response than Chrome.',
      challenged:        'Bot hit a Cloudflare or captcha challenge page.',
      blocked:           'Bot got a 4xx or 5xx error before reaching content.',
      fetch_failed:      'Network error or timeout.',
      unknown:           ''
    };
    const rows = probes.results.map((r) => {
      const v = verdictByStatus[r.status] || verdictByStatus.unknown;
      let detail = v.label;
      if (r.status === 'no_cloaking' && typeof r.similarityToChrome === 'number') {
        detail = `${v.label} · ${Math.round(r.similarityToChrome * 100)}% match`;
      } else if (r.status === 'dynamic_rendering' && typeof r.lengthRatio === 'number' && isFinite(r.lengthRatio)) {
        const pct = Math.round((r.lengthRatio - 1) * 100);
        detail = `${v.label} +${pct}%`;
      } else if (r.status === 'served_less' && typeof r.lengthRatio === 'number') {
        const pct = Math.round((1 - r.lengthRatio) * 100);
        detail = `${v.label} −${pct}%`;
      } else if (r.status === 'blocked' && r.statusCode) {
        detail = `${v.label} (HTTP ${r.statusCode})`;
      } else if (r.status === 'fetch_failed' && r.error) {
        detail = `${v.label} (${this.escape(r.error)})`;
      }
      const tipParts = [];
      if (explainStatus[r.status]) tipParts.push(explainStatus[r.status]);
      if (r.userAgent) tipParts.push(`UA: ${r.userAgent}`);
      const tip = tipParts.join('\n\n');
      return `
        <div class="bot-probe-row" data-tooltip="${this.escape(tip)}">
          <span class="bot-probe-dot ${v.dot}"></span>
          <div>
            <span class="bot-probe-name">${this.escape(r.name)}</span>
            <span class="bot-probe-vendor">${this.escape(r.vendor)}</span>
          </div>
          <span class="bot-probe-verdict">${this.escape(detail)}</span>
        </div>`;
    }).join('');
    this.botProbesListEl.innerHTML = rows;

    // If we promoted a bot fetch to canonical baseline, surface it
    if (this.botProbesBaselineEl) {
      if (server && server.canonicalSource && server.canonicalSource.startsWith('bot:')) {
        const botName = server.canonicalSource.slice(4);
        this.botProbesBaselineEl.textContent =
          `Score baseline switched to ${botName}. Richer than the Chrome fetch.`;
        this.botProbesBaselineEl.style.display = 'block';
      } else {
        this.botProbesBaselineEl.style.display = 'none';
      }
    }

    this.botProbesSectionEl.style.display = 'block';
  }

  // ---------- Issues + Recs ----------

  renderIssues(issues) {
    this.issuesListEl.innerHTML = '';
    issues.forEach((issue) => {
      const el = document.createElement('div');
      el.className = `issue ${issue.severity}`;
      // Impact text moves into the hover tooltip — single-line cards by default.
      if (issue.impact) {
        el.setAttribute('data-tooltip', issue.impact);
        el.setAttribute('data-tooltip-pos', 'below');
      }
      el.innerHTML = `<div class="issue-message">${this.escape(issue.message)}</div>`;
      this.issuesListEl.appendChild(el);
    });
  }

  renderRecommendations(recommendations) {
    this.recsListEl.innerHTML = '';
    recommendations.forEach((rec) => {
      const el = document.createElement('div');
      el.className = 'rec';
      if (rec.description) {
        el.setAttribute('data-tooltip', rec.description);
        el.setAttribute('data-tooltip-pos', 'below');
      }
      el.innerHTML = `<div class="rec-action">${this.escape(rec.action)}</div>`;
      this.recsListEl.appendChild(el);
    });
  }

  async handlePrimaryCTA() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const currentUrl = tabs[0] && tabs[0].url;
    let domain = 'unknown';
    try {
      domain = new URL(currentUrl).hostname || 'unknown';
    } catch (_) { /* keep 'unknown' */ }

    const params = new URLSearchParams({ source: 'extension', website: domain });
    chrome.tabs.create({
      url: `https://www.alliai.com/?${params.toString()}`
    });
  }

  renderPostHydrationNotice() {
    if (!this.postHydrationNoticeEl) return;
    this.postHydrationNoticeEl.className = 'post-hydration-notice';
    this.postHydrationNoticeEl.textContent =
      'Analyzed after the page finished loading. Frameworks may have already rendered. Reload the page for the most accurate view.';
  }

  async handleDownloadReport() {
    if (!this.lastResults) return;
    try {
      await chrome.storage.session.set({
        'report:pending': { results: this.lastResults, url: this.pageUrl || '' }
      });
      await chrome.tabs.create({ url: chrome.runtime.getURL('report.html') });
      window.close();
    } catch (error) {
      console.error('Failed to open report:', error);
    }
  }

  // ---------- utilities ----------

  escape(s) {
    return String(s == null ? '' : s).replace(/[<>&"']/g, (c) => (
      { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
}

function initPopup() {
  new TooltipManager();
  new PopupManager();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPopup);
} else {
  initPopup();
}
