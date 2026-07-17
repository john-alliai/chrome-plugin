// AI Search Visibility Checker — Content Script
//
// Snapshots the page from the perspective of an AI crawler that does NOT
// execute JavaScript, with a 2-second budget on both sides:
//
//   • Raw fetch    — fetches the server HTML through the SW with a 2s timeout.
//                    Whatever HTML hasn't streamed in by then is "invisible to
//                    a 2s-budget crawler."
//   • Rendered     — snapshots the live DOM at analysis time, so the
//                    comparison reflects what the user currently sees.
//
// Both snapshots produce the same shape (text, headings h1–h6, links + internal,
// has_main / has_title / has_meta_desc) so they can be compared symmetrically.
// We compute text_ratio (length-based) and content_overlap (Jaccard, similarity-
// based), then derive a segment label (fully_accessible / partially_accessible /
// js_dependent) — the same vocabulary as the backend crawl reports.

(function () {
  if (window.aiSearchVisibilityCheckerLoaded) return;
  window.aiSearchVisibilityCheckerLoaded = true;

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const RAW_FETCH_TIMEOUT_MS = 2000;       // 2s budget for raw HTML
  const SUPPORT_FETCH_TIMEOUT_MS = 6000;   // robots.txt / llms.txt / sitemap.xml
  const BOT_PROBE_TIMEOUT_MS = 3000;       // bot probes get a slightly looser budget

  // Bot UAs we probe with when V2 is enabled. UAs are real strings the bots
  // publish, so well-behaved servers can route them correctly. If a server
  // serves dynamic-rendered HTML to known bots, this is the path that catches
  // it.
  const BOT_PROBES = [
    {
      key: 'gptbot',
      name: 'GPTBot',
      vendor: 'OpenAI',
      userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)'
    },
    {
      key: 'claudebot',
      name: 'ClaudeBot',
      vendor: 'Anthropic',
      userAgent: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)'
    },
    {
      key: 'perplexitybot',
      name: 'PerplexityBot',
      vendor: 'Perplexity',
      userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)'
    }
  ];

  // Patterns that suggest the server returned an interstitial (Cloudflare,
  // Akamai, Datadome, hCaptcha, etc.) instead of real content. We use these
  // when the bot fetch is much shorter than the Chrome fetch — short alone
  // is ambiguous (could just be unauthenticated content).
  const CHALLENGE_PATTERNS = [
    /just a moment/i,
    /attention required/i,
    /cloudflare/i,
    /verify you (?:are|'re) human/i,
    /please complete the security check/i,
    /captcha/i,
    /enable javascript and cookies to continue/i,
    /access denied/i
  ];

  const AI_CRAWLERS = [
    { name: 'GPTBot',            vendor: 'OpenAI',     purpose: 'Training data for ChatGPT' },
    { name: 'OAI-SearchBot',     vendor: 'OpenAI',     purpose: 'ChatGPT Search index' },
    { name: 'ChatGPT-User',      vendor: 'OpenAI',     purpose: 'Live browse from ChatGPT' },
    { name: 'ClaudeBot',         vendor: 'Anthropic',  purpose: 'Training / search index' },
    { name: 'anthropic-ai',      vendor: 'Anthropic',  purpose: 'Anthropic crawler (legacy)' },
    { name: 'Claude-Web',        vendor: 'Anthropic',  purpose: 'Live browse from Claude' },
    { name: 'PerplexityBot',     vendor: 'Perplexity', purpose: 'Perplexity index' },
    { name: 'Perplexity-User',   vendor: 'Perplexity', purpose: 'Live browse from Perplexity' },
    { name: 'Google-Extended',   vendor: 'Google',     purpose: 'Gemini / Vertex AI training' },
    { name: 'CCBot',             vendor: 'CommonCrawl', purpose: 'Open dataset (used by many LLMs)' },
    { name: 'Bytespider',        vendor: 'ByteDance',  purpose: 'Doubao / training' },
    { name: 'Applebot-Extended', vendor: 'Apple',      purpose: 'Apple Intelligence training' }
  ];

  // Score weights — Performance has been dropped; load speed now applies as
  // a multiplicative penalty on the final score (see computeScores).
  const SCORE_WEIGHTS = {
    serverVisibility: 40,
    crawlerAccess:    30,
    structuredData:   18,
    robotsRestrictions: 12
  };

  // Segment tiers, driven by MIN(textRatio, contentOverlap) — the same
  // value the user sees as the headline percentage. Ordered top-down: the
  // first tier whose `min` clears wins.
  //   Fully Visible       ≥ 90%
  //   Mostly Visible      80–89%
  //   Partially Visible   65–79%
  //   Slipping            50–64%
  //   Failing             25–49%
  //   Invisible           < 25%
  const SEGMENT_TIERS = [
    { key: 'fully_accessible',     min: 0.90 },
    { key: 'mostly_visible',       min: 0.80 },
    { key: 'partially_accessible', min: 0.65 },
    { key: 'slipping',             min: 0.50 },
    { key: 'js_dependent',         min: 0.25 },
    { key: 'invisible',            min: 0    }
  ];

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  // Token set used by Jaccard similarity. Filters short tokens (<3 chars) and
  // pure numeric tokens to reduce noise from punctuation, articles, and prices.
  function tokenize(text) {
    const matches = (text || '').toLowerCase().match(/[a-z][a-z0-9']{2,}/g);
    return new Set(matches || []);
  }

  function jaccardSimilarity(textA, textB) {
    const a = tokenize(textA);
    const b = tokenize(textB);
    if (a.size === 0 && b.size === 0) return 1;
    if (a.size === 0 || b.size === 0) return 0;
    let intersect = 0;
    for (const w of a) if (b.has(w)) intersect++;
    return intersect / (a.size + b.size - intersect);
  }

  // Symmetric snapshot — same shape for raw HTML and live DOM so they can be
  // compared field-for-field.
  function captureSnapshot(doc, hostname) {
    if (!doc) return null;
    const body = doc.body;
    const text = (body && body.textContent || '').trim();

    const headings = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
    let totalHeadings = 0;
    for (let i = 1; i <= 6; i++) {
      const c = doc.querySelectorAll('h' + i).length;
      headings['h' + i] = c;
      totalHeadings += c;
    }

    let totalLinks = 0;
    let internalLinks = 0;
    const linkEls = doc.querySelectorAll('a[href]');
    for (const a of linkEls) {
      const href = a.getAttribute('href');
      if (!href || href === '#' || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
      totalLinks++;
      try {
        const url = new URL(href, `https://${hostname}/`);
        if (url.hostname === hostname) internalLinks++;
      } catch (_) { /* malformed href — count as external/skip */ }
    }

    const title = (doc.title || '').trim();
    const metaDesc = doc.querySelector('meta[name="description"]');
    const metaDescContent = metaDesc ? (metaDesc.getAttribute('content') || '').trim() : '';

    return {
      text,
      textLength: text.length,
      headings,
      totalHeadings,
      totalLinks,
      internalLinks,
      hasMain: !!doc.querySelector('main'),
      hasTitle: !!title,
      hasMetaDesc: !!metaDescContent
    };
  }

  // ---------------------------------------------------------------------------
  // Network helpers (delegated to SW to bypass page CSP)
  // ---------------------------------------------------------------------------

  async function fetchViaSW(url, timeoutMs) {
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'FETCH_URL',
        url,
        timeoutMs
      });
      return result || { ok: false, error: 'no-response' };
    } catch (error) {
      return { ok: false, error: (error && error.message) || String(error) };
    }
  }

  async function probeViaSW(url, userAgent, timeoutMs) {
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'PROBE_URL',
        url,
        userAgent,
        timeoutMs
      });
      return result || { ok: false, error: 'no-response' };
    } catch (error) {
      return { ok: false, error: (error && error.message) || String(error) };
    }
  }

  async function readSetting(key, fallback) {
    try {
      const obj = await chrome.storage.local.get(key);
      return key in obj ? obj[key] : fallback;
    } catch (_) {
      return fallback;
    }
  }

  // ---------------------------------------------------------------------------
  // Robots.txt parsing
  // ---------------------------------------------------------------------------

  function parseRobots(text) {
    const groups = [];
    const sitemaps = [];
    let current = null;
    let lastWasUA = false;

    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) continue;
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const directive = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();

      if (directive === 'user-agent') {
        if (!current || !lastWasUA) {
          current = { userAgents: [], rules: [] };
          groups.push(current);
        }
        current.userAgents.push(value);
        lastWasUA = true;
      } else if (directive === 'allow' || directive === 'disallow') {
        if (current) current.rules.push({ type: directive, value });
        lastWasUA = false;
      } else if (directive === 'sitemap') {
        sitemaps.push(value);
        lastWasUA = false;
      } else {
        lastWasUA = false;
      }
    }
    return { groups, sitemaps };
  }

  // Match a robots.txt path pattern against a URL path. Supports the two
  // wildcards specified by Google's robots.txt spec / RFC 9309:
  //   *  match any sequence of characters
  //   $  anchor to end of URL (only meaningful at end of pattern)
  function matchesRobotsPattern(path, pattern) {
    if (!pattern) return false;
    if (pattern === '/') return true;
    let regex = '^';
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === '*') regex += '.*';
      else if (c === '$' && i === pattern.length - 1) regex += '$';
      else regex += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
    try { return new RegExp(regex).test(path); }
    catch (_) { return false; }
  }

  // Per-page bot access. Find the matching User-agent group (specific UA
  // wins over wildcard), then resolve allow/disallow rules against THIS
  // page's path. Per RFC 9309: longest-matching rule wins; allow beats
  // disallow at equal length.
  //
  // Older logic flagged any bot as `partial` if its group had any disallow
  // rules at all — that made every site with vanilla `Disallow: /admin`
  // hygiene show "12 AI crawlers restricted" (true in the abstract, useless
  // for per-page diagnosis). Now `partial` is gone: per page, a bot either
  // CAN fetch the URL or it CAN'T.
  function checkAIBotAccess(parsed, botName, currentPath) {
    const lower = botName.toLowerCase();
    let specific = null;
    let wildcard = null;

    for (const group of parsed.groups) {
      for (const ua of group.userAgents) {
        const u = ua.toLowerCase();
        if (u === lower) specific = group;
        else if (u === '*') wildcard = group;
      }
    }

    const matched = specific || wildcard;
    if (!matched) return { status: 'allowed', source: 'no-rules' };

    let bestRule = null;
    for (const rule of matched.rules) {
      if (rule.type !== 'allow' && rule.type !== 'disallow') continue;
      if (!rule.value) continue; // empty Disallow = allow all; skip
      if (!matchesRobotsPattern(currentPath, rule.value)) continue;
      if (!bestRule
          || rule.value.length > bestRule.value.length
          || (rule.value.length === bestRule.value.length && rule.type === 'allow' && bestRule.type !== 'allow')) {
        bestRule = rule;
      }
    }

    const source = specific ? 'specific' : 'wildcard';
    const matchedUA = matched.userAgents[0];

    if (!bestRule || bestRule.type === 'allow') {
      return { status: 'allowed', source, matchedUA };
    }
    return {
      status: 'blocked',
      source,
      matchedUA,
      fullBlock: bestRule.value === '/',
      matchedRule: bestRule.value
    };
  }

  // ---------------------------------------------------------------------------
  // Performance observation
  // ---------------------------------------------------------------------------

  let lcpEntries = [];
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) lcpEntries.push(entry);
    });
    obs.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (_) { /* not supported; fall through */ }

  function readPerformance() {
    const nav = (performance.getEntriesByType('navigation') || [])[0];
    const paints = performance.getEntriesByType('paint') || [];
    const fcp = paints.find((p) => p.name === 'first-contentful-paint');
    const lastLcp = lcpEntries[lcpEntries.length - 1];
    const scriptCount = document.querySelectorAll('script[src]').length;

    // TTFB = responseStart - requestStart. Falls back to responseStart - startTime
    // if requestStart isn't populated (rare; happens with some sw cache hits).
    let ttfbMs = null;
    if (nav) {
      const base = nav.requestStart || nav.startTime;
      if (typeof nav.responseStart === 'number' && nav.responseStart >= base) {
        ttfbMs = Math.round(nav.responseStart - base);
      }
    }

    return {
      domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd - nav.startTime) : null,
      loadCompleteMs: nav && nav.loadEventEnd ? Math.round(nav.loadEventEnd - nav.startTime) : null,
      transferSizeBytes: nav && nav.transferSize ? nav.transferSize : null,
      ttfbMs,
      fcpMs: fcp ? Math.round(fcp.startTime) : null,
      lcpMs: lastLcp ? Math.round(lastLcp.renderTime || lastLcp.loadTime || lastLcp.startTime) : null,
      scriptCount
    };
  }

  // ---------------------------------------------------------------------------
  // JSON-LD parsing
  // ---------------------------------------------------------------------------

  function parseJSONLDBlocks() {
    const out = [];
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      const raw = s.textContent;
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        const flatten = (node) => {
          if (!node) return;
          if (Array.isArray(node)) { node.forEach(flatten); return; }
          if (typeof node !== 'object') return;
          if (Array.isArray(node['@graph'])) node['@graph'].forEach(flatten);
          out.push(node);
        };
        flatten(parsed);
      } catch (_) { /* ignore malformed */ }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // The analyzer
  // ---------------------------------------------------------------------------

  class Analyzer {
    constructor() {
      this.analysis = {
        score: 0,
        scoreBreakdown: {},
        segment: 'unknown',
        issues: [],
        recommendations: [],
        details: {},
        server: { fetched: false },
        crawlers: { fetched: false, bots: [] },
        aiSearchFiles: { llmsTxtPresent: false, sitemapPresent: false, sitemapDeclared: false },
        performance: {}
      };
    }

    async run() {
      // Wait for `load` so navigation timing and LCP populate, but cap so
      // ridiculously slow pages don't stall the analysis indefinitely.
      await this.waitForLoadOrTimeout(8000);

      // Probe-as-AI-crawlers is on by default; users can opt out via the
      // popup toggle. This makes cloaking detection and dynamic-rendering
      // recognition the standard analysis, not a hidden feature.
      const probeEnabled = await readSetting('probeAsAiCrawlers', true);

      const origin = window.location.origin;
      const [serverData, robotsData, llmsRes, sitemapRes] = await Promise.all([
        fetchViaSW(window.location.href, RAW_FETCH_TIMEOUT_MS),
        fetchViaSW(origin + '/robots.txt', SUPPORT_FETCH_TIMEOUT_MS),
        fetchViaSW(origin + '/llms.txt',   SUPPORT_FETCH_TIMEOUT_MS),
        fetchViaSW(origin + '/sitemap.xml', SUPPORT_FETCH_TIMEOUT_MS)
      ]);
      const renderedSnap = captureSnapshot(document, window.location.hostname);

      this.analyzeServer(serverData, renderedSnap);
      this.analyzeRobots(robotsData);
      this.analyzeLLMsTxt(llmsRes);
      this.analyzeSitemap(sitemapRes, robotsData);

      this.analysis.performance = readPerformance();

      // V2: probe with bot UAs sequentially (DNR session rule serializes
      // anyway; doing them in parallel would just queue at the SW lock).
      if (probeEnabled) {
        await this.runBotProbes(serverData, renderedSnap);
        this.maybePromoteCanonicalBaseline(renderedSnap);
      } else {
        this.analysis.botProbes = { enabled: false, results: [] };
      }

      this.detectFrameworks();
      this.checkStructuredData();
      this.checkSlowLoad();
      this.classifySegment();
      this.consolidateRelatedIssues();
      this.computeScores();
      this.generateRecommendations();

      // Strip private fields from bot probes — they hold full HTML bodies
      // that are only needed during the analysis run, and would otherwise
      // bloat chrome.storage.session past quota.
      if (this.analysis.botProbes && this.analysis.botProbes.results) {
        for (const r of this.analysis.botProbes.results) {
          delete r._snap;
          delete r._text;
        }
      }

      return this.analysis;
    }

    waitForLoadOrTimeout(maxMs) {
      return new Promise((resolve) => {
        if (document.readyState === 'complete') {
          setTimeout(resolve, 600);
          return;
        }
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        window.addEventListener('load', () => setTimeout(finish, 600), { once: true });
        setTimeout(finish, maxMs);
      });
    }

    // -------------------------------------------------------------------------
    // Server vs rendered comparison
    // -------------------------------------------------------------------------

    analyzeServer(result, renderedSnap) {
      if (!result || !result.ok) {
        this.analysis.server = {
          fetched: false,
          error: (result && result.error) || 'fetch-failed',
          rendered: renderedSnap
        };
        return;
      }

      const headers = result.headers || {};
      const xRobots = headers['x-robots-tag'] || null;
      const contentType = headers['content-type'] || null;
      const linkHeader = headers['link'] || null;
      const canonicalFromHeader = parseCanonicalLink(linkHeader);

      let serverDoc = null;
      try {
        serverDoc = new DOMParser().parseFromString(result.text || '', 'text/html');
      } catch (_) { /* fall through */ }

      const hostname = window.location.hostname;
      const rawSnap = captureSnapshot(serverDoc, hostname);
      const liveSnap = renderedSnap || captureSnapshot(document, hostname);

      // text_ratio — length-based "how much made it into the server response"
      const textRatio = rawSnap && liveSnap && liveSnap.textLength > 0
        ? Math.min(1, rawSnap.textLength / liveSnap.textLength)
        : (rawSnap && rawSnap.textLength > 0 ? 1 : 0);

      // content_overlap — Jaccard similarity, catches "same length, different
      // content" cases (loading placeholders, personalization swaps, etc.)
      const contentOverlap = rawSnap && liveSnap
        ? jaccardSimilarity(rawSnap.text, liveSnap.text)
        : 0;

      // Link / heading / structural ratios — how much of each survives as raw
      const ratio = (a, b) => (b > 0 ? Math.min(1, a / b) : (a > 0 ? 1 : 0));
      const linkRatio = rawSnap && liveSnap ? ratio(rawSnap.totalLinks, liveSnap.totalLinks) : 0;
      const internalLinkRatio = rawSnap && liveSnap ? ratio(rawSnap.internalLinks, liveSnap.internalLinks) : 0;
      const headingRatio = rawSnap && liveSnap ? ratio(rawSnap.totalHeadings, liveSnap.totalHeadings) : 0;

      const canonicalEl = (serverDoc && serverDoc.querySelector('link[rel="canonical"]'))
        || document.querySelector('link[rel="canonical"]');
      const canonicalUrl = canonicalFromHeader
        || (canonicalEl ? canonicalEl.getAttribute('href') : null);

      this.analysis.server = {
        fetched: true,
        statusCode: result.status,
        redirected: result.redirected,
        finalUrl: result.finalUrl,
        contentType,
        xRobotsTag: xRobots,
        canonicalUrl,

        // Symmetric per-side snapshots
        raw: rawSnap,
        rendered: liveSnap,

        // V1 metrics (mirrors the backend crawl-report names)
        textRatio,
        contentOverlap,
        linkRatio,
        internalLinkRatio,
        headingRatio,

        // Backwards-compat aliases (kept so existing code paths keep working)
        visibilityRatio: textRatio,
        serverTextLength: rawSnap ? rawSnap.textLength : 0,
        liveTextLength: liveSnap ? liveSnap.textLength : 0,
        serverHeadings: rawSnap ? rawSnap.totalHeadings : 0,
        liveHeadings: liveSnap ? liveSnap.totalHeadings : 0,

        truncated: !!result.truncated
      };

      // ---- Issues derived from the comparison ---------------------------------

      // text_ratio alone — page is short on raw text
      if (liveSnap && liveSnap.textLength > 200 && textRatio < 0.3) {
        this.analysis.issues.push({
          type: 'low_server_visibility',
          severity: 'high',
          message: `Server has only ${Math.round(textRatio * 100)}% of the page text`,
          impact: 'Bots without JavaScript see most of this page as empty.',
          roiImpact: Math.round((1 - textRatio) * 70)
        });
      } else if (liveSnap && liveSnap.textLength > 200 && textRatio < 0.6) {
        this.analysis.issues.push({
          type: 'low_server_visibility',
          severity: 'medium',
          message: `Server has only ${Math.round(textRatio * 100)}% of the page text`,
          impact: 'Bots will miss content that loads with JavaScript.',
          roiImpact: Math.round((1 - textRatio) * 50)
        });
      }

      if (rawSnap && rawSnap.textLength > 100 && liveSnap && liveSnap.textLength > 100) {
        if (contentOverlap < 0.3) {
          this.analysis.issues.push({
            type: 'low_content_overlap',
            severity: 'high',
            message: `Only ${Math.round(contentOverlap * 100)}% word overlap with rendered page`,
            impact: 'The text bots see is different from what users see.',
            roiImpact: 35
          });
        } else if (contentOverlap < 0.6 && textRatio >= 0.6) {
          this.analysis.issues.push({
            type: 'content_drift',
            severity: 'medium',
            message: `Content drift: ${Math.round(contentOverlap * 100)}% word overlap`,
            impact: 'Server HTML is the right length but the words differ from the rendered page.',
            roiImpact: 20
          });
        }
      }

      if (liveSnap && liveSnap.totalHeadings > 2 && (!rawSnap || rawSnap.totalHeadings === 0)) {
        this.analysis.issues.push({
          type: 'js_rendered_headings',
          severity: 'high',
          message: 'Headings are JS-rendered',
          impact: 'Server HTML has no headings. Crawlers use them to parse page structure.',
          roiImpact: 35
        });
      }

      const jsOnlyMissing = [];
      if (rawSnap && liveSnap) {
        if (!rawSnap.hasTitle && liveSnap.hasTitle) jsOnlyMissing.push('<title>');
        if (!rawSnap.hasMetaDesc && liveSnap.hasMetaDesc) jsOnlyMissing.push('meta description');
        if (!rawSnap.hasMain && liveSnap.hasMain) jsOnlyMissing.push('<main>');
      }
      if (jsOnlyMissing.length > 0) {
        this.analysis.issues.push({
          type: 'js_rendered_meta',
          severity: jsOnlyMissing.includes('<title>') ? 'high' : 'medium',
          message: `JS-rendered: ${jsOnlyMissing.join(', ')}`,
          impact: 'Server HTML is missing these elements. Bots without JS won\'t see them.',
          roiImpact: 15 * jsOnlyMissing.length,
          missing: jsOnlyMissing
        });
      }

      if (xRobots && /noindex|nofollow|none/i.test(xRobots)) {
        this.analysis.issues.push({
          type: 'xrobots_restrictive',
          severity: 'high',
          message: `X-Robots-Tag: ${xRobots}`,
          impact: 'This header tells crawlers not to index the page.',
          roiImpact: 90
        });
      }

      if (!canonicalUrl) {
        this.analysis.issues.push({
          type: 'no_canonical',
          severity: 'low',
          message: 'No canonical URL',
          impact: 'Crawlers can\'t tell which URL variant to index.',
          roiImpact: 5
        });
      }

      const robotsMeta = document.querySelector('meta[name="robots"]');
      if (robotsMeta) {
        const content = (robotsMeta.getAttribute('content') || '').toLowerCase();
        if (content && (content.includes('noindex') || content.includes('nofollow'))) {
          this.analysis.issues.push({
            type: 'robots_meta_restrictive',
            severity: 'high',
            message: `Meta robots: ${content}`,
            impact: 'This tag tells crawlers not to index the page.',
            roiImpact: 90
          });
        }
      }

      const ttfb = readPerformance().ttfbMs;
      if (ttfb != null && ttfb > 1500) {
        this.analysis.issues.push({
          type: 'slow_ttfb',
          severity: ttfb > 2500 ? 'high' : 'medium',
          message: `TTFB ${(ttfb / 1000).toFixed(2)}s`,
          impact: 'Crawlers with 2-second budgets quit before the page starts loading.',
          roiImpact: ttfb > 2500 ? 30 : 15
        });
      }
    }

    // -------------------------------------------------------------------------
    // Robots.txt + AI crawler access
    // -------------------------------------------------------------------------

    analyzeRobots(result) {
      if (!result || !result.ok) {
        this.analysis.crawlers = {
          fetched: false,
          bots: AI_CRAWLERS.map((b) => ({ ...b, status: 'unknown' })),
          error: (result && result.error) || 'fetch-failed'
        };
        return;
      }
      const parsed = parseRobots(result.text || '');
      const currentPath = window.location.pathname + window.location.search;
      const bots = AI_CRAWLERS.map((b) => ({
        ...b,
        ...checkAIBotAccess(parsed, b.name, currentPath)
      }));
      this.analysis.crawlers = {
        fetched: true,
        bots,
        sitemapDeclared: parsed.sitemaps.length > 0,
        sitemapEntries: parsed.sitemaps
      };
      this.analysis.aiSearchFiles.sitemapDeclared = parsed.sitemaps.length > 0;

      const blocked = bots.filter((b) => b.status === 'blocked');
      if (blocked.length === 0) return;

      const specific = blocked.filter((b) => b.source === 'specific');
      const wildcardBlocked = blocked.filter((b) => b.source === 'wildcard');

      if (specific.length > 0) {
        this.analysis.issues.push({
          type: 'ai_crawlers_blocked_specific',
          severity: 'high',
          message: `${specific.length} AI crawler${specific.length > 1 ? 's' : ''} blocked from this page`,
          impact: `${specific.map((b) => b.name).join(', ')} explicitly disallowed in robots.txt.`,
          roiImpact: Math.min(80, specific.length * 20),
          bots: specific.map((b) => b.name)
        });
      }
      if (wildcardBlocked.length > 0) {
        const fullSiteBlock = wildcardBlocked.some((b) => b.fullBlock);
        this.analysis.issues.push({
          type: 'ai_crawlers_blocked_wildcard',
          severity: 'high',
          message: fullSiteBlock
            ? 'All crawlers blocked by Disallow: /'
            : 'This page blocked for all crawlers',
          impact: 'No crawler can fetch this URL.',
          roiImpact: 85
        });
      }
    }

    analyzeLLMsTxt(result) {
      const present = !!(result && result.ok && result.status === 200 && (result.text || '').length > 0);
      this.analysis.aiSearchFiles.llmsTxtPresent = present;
    }

    analyzeSitemap(result, robotsResult) {
      const fileExists = !!(result && result.ok && result.status === 200);
      const declaredInRobots = !!(robotsResult && robotsResult.ok && /^\s*sitemap\s*:/im.test(robotsResult.text || ''));
      this.analysis.aiSearchFiles.sitemapPresent = fileExists;
      this.analysis.aiSearchFiles.sitemapDeclared = declaredInRobots || this.analysis.aiSearchFiles.sitemapDeclared;

      if (!fileExists && !declaredInRobots) {
        this.analysis.issues.push({
          type: 'no_sitemap',
          severity: 'low',
          message: 'No sitemap.xml',
          impact: 'No /sitemap.xml and none declared in robots.txt. Crawlers may miss pages.',
          roiImpact: 5
        });
      }
    }

    // -------------------------------------------------------------------------
    // Framework / structured data / industry detection
    // -------------------------------------------------------------------------

    detectFrameworks() {
      const scripts = Array.from(document.querySelectorAll('script')).map((s) => s.src || s.textContent || '');
      const has = (needle) => scripts.some((s) => s.includes(needle));
      const detected = new Set();

      if (
        document.querySelector('[data-reactroot], [data-react-helmet], #__next, #__nuxt') ||
        has('react-dom') || has('/react.') || has('/react@')
      ) detected.add('react');

      const vueAttrSeen = (() => {
        const els = document.querySelectorAll('*');
        for (let i = 0; i < els.length; i++) {
          const attrs = els[i].attributes;
          for (let j = 0; j < attrs.length; j++) {
            if (attrs[j].name.startsWith('data-v-')) return true;
          }
        }
        return false;
      })();
      if (
        document.querySelector('[v-cloak], [data-server-rendered]') || vueAttrSeen ||
        has('/vue.') || has('/vue@') || has('nuxt')
      ) detected.add('vue');

      if (
        document.querySelector('app-root, [ng-version], [ng-server-context]') ||
        document.querySelector('[ng-app], [ng-controller]') ||
        has('@angular/') || has('angular.js') || has('/angular.')
      ) detected.add('angular');

      const svelteClassSeen = (() => {
        const els = document.querySelectorAll('[class]');
        for (let i = 0; i < els.length; i++) {
          if (/(^|\s)svelte-[a-z0-9]+/i.test(els[i].getAttribute('class') || '')) return true;
        }
        return false;
      })();
      if (svelteClassSeen || has('svelte') || has('sveltekit')) detected.add('svelte');

      this.analysis.details.frameworks = Array.from(detected);
    }

    checkStructuredData() {
      const blocks = parseJSONLDBlocks();
      const hasMicrodata = !!document.querySelector('[itemscope], [vocab]');
      const hasJsonLd = blocks.length > 0;
      this.analysis.details.jsonLdBlocks = blocks.length;
      this.analysis.details.hasMicrodata = hasMicrodata;
      this.analysis.details.jsonLdTypes = blocks.flatMap((b) => {
        const t = b['@type'];
        if (!t) return [];
        return Array.isArray(t) ? t : [t];
      });

      if (!hasJsonLd && !hasMicrodata) {
        this.analysis.issues.push({
          type: 'no_structured_data',
          severity: 'medium',
          message: 'No structured data',
          impact: 'No JSON-LD or microdata. Without it, crawlers can\'t tell what the page is about.',
          roiImpact: 30
        });
      }
    }

    checkSlowLoad() {
      // Load speed = full page load time. Crawlers time out fast; anything
      // past a few seconds risks being missed. Score gets a separate
      // multiplicative penalty in computeScores; this just surfaces an
      // explicit issue once it crosses 2s.
      const loadMs = this.analysis.performance.loadCompleteMs
        || this.analysis.performance.lcpMs;
      if (loadMs == null) return;
      const loadSec = loadMs / 1000;
      if (loadSec > 4) {
        this.analysis.issues.push({
          type: 'slow_load',
          severity: 'high',
          message: `Load speed ${loadSec.toFixed(1)}s`,
          impact: 'Crawlers will time out before the page finishes loading.'
        });
      } else if (loadSec > 2) {
        this.analysis.issues.push({
          type: 'slow_load',
          severity: 'medium',
          message: `Load speed ${loadSec.toFixed(1)}s`,
          impact: 'Pages slower than 2s lose crawler attention.'
        });
      }

      const transfer = this.analysis.performance.transferSizeBytes;
      if (transfer && transfer > 4_000_000) {
        this.analysis.issues.push({
          type: 'large_transfer',
          severity: 'low',
          message: `Page weighs ${(transfer / 1_000_000).toFixed(1)} MB`,
          impact: 'Heavy pages get crawled less often.'
        });
      }
    }

    // -------------------------------------------------------------------------
    // V2 — Bot UA probes
    //
    // For each of GPTBot / ClaudeBot / PerplexityBot we install a temporary
    // DNR session rule overriding User-Agent for a single fetch of the page.
    // We then classify how the bot's response compares to the Chrome fetch:
    //
    //   no_cloaking         — bot and Chrome see the same content
    //   dynamic_rendering   — bot sees materially MORE content (good for AI)
    //   served_less         — bot sees materially LESS content (bad)
    //   challenged          — bot got a Cloudflare/captcha/challenge page
    //   blocked             — bot got 403 / 429 / 451 etc.
    //   fetch_failed        — network error or timeout
    // -------------------------------------------------------------------------

    async runBotProbes(chromeServerData, renderedSnap) {
      const url = window.location.href;
      const hostname = window.location.hostname;
      const chromeText = chromeServerData && chromeServerData.ok ? (chromeServerData.text || '') : '';
      const chromeLen = chromeText.length;
      const results = [];

      for (const probe of BOT_PROBES) {
        const probeRes = await probeViaSW(url, probe.userAgent, BOT_PROBE_TIMEOUT_MS);
        results.push(this.classifyBotProbe(probe, probeRes, chromeText, chromeLen, renderedSnap, hostname));
      }

      this.analysis.botProbes = { enabled: true, results };

      // Issues derived from probe results
      const blocked = results.filter((r) => r.status === 'blocked' || r.status === 'challenged');
      const servedLess = results.filter((r) => r.status === 'served_less');
      const dynamic = results.filter((r) => r.status === 'dynamic_rendering');

      if (blocked.length > 0) {
        this.analysis.issues.push({
          type: 'bot_probe_blocked',
          severity: 'high',
          message: `${blocked.length} bot${blocked.length > 1 ? 's' : ''} blocked at the edge`,
          impact: `${blocked.map((r) => r.name).join(', ')} got a challenge page or HTTP error. Cloudflare, Akamai, or a captcha gate is rejecting these bots before they reach content.`,
          roiImpact: Math.min(60, blocked.length * 25),
          bots: blocked.map((r) => r.name)
        });
      }
      if (servedLess.length > 0) {
        this.analysis.issues.push({
          type: 'bot_probe_served_less',
          severity: 'medium',
          message: `${servedLess.length} bot${servedLess.length > 1 ? 's' : ''} served less content`,
          impact: `${servedLess.map((r) => r.name).join(', ')} received a smaller or different response than Chrome.`,
          roiImpact: 15 * servedLess.length,
          bots: servedLess.map((r) => r.name)
        });
      }
      if (dynamic.length > 0) {
        // Positive signal — surface as a recommendation note rather than an issue
        this.analysis.details.dynamicRenderingDetected = dynamic.map((r) => r.name);
      }
    }

    classifyBotProbe(probe, probeRes, chromeText, chromeLen, renderedSnap, hostname) {
      const out = {
        key: probe.key,
        name: probe.name,
        vendor: probe.vendor,
        userAgent: probe.userAgent,
        status: 'unknown',
        statusCode: null,
        textLength: 0,
        lengthRatio: null,
        similarityToChrome: null,
        visibilityRatio: null,
        contentOverlap: null,
        error: null
      };

      if (!probeRes || !probeRes.ok) {
        out.status = 'fetch_failed';
        out.error = (probeRes && probeRes.error) || 'no-response';
        return out;
      }

      out.statusCode = probeRes.status;

      // Explicit block status codes — treat as blocked regardless of body
      if ([401, 403, 405, 429, 451, 503].includes(probeRes.status)) {
        out.status = 'blocked';
        return out;
      }

      const botText = probeRes.text || '';
      out.textLength = botText.length;

      // Parse for symmetric comparison
      let botDoc = null;
      try { botDoc = new DOMParser().parseFromString(botText, 'text/html'); } catch (_) {}
      const botSnap = captureSnapshot(botDoc, hostname);
      const botBodyText = botSnap ? botSnap.text : '';

      // Compare to Chrome fetch first
      out.similarityToChrome = jaccardSimilarity(chromeText, botText);
      out.lengthRatio = chromeLen > 0 ? botText.length / chromeLen : (botText.length > 0 ? Infinity : 0);

      // Compare to rendered snapshot (this is what we'd substitute in if we
      // promoted this bot fetch to the canonical baseline)
      if (renderedSnap && renderedSnap.textLength > 0) {
        out.visibilityRatio = Math.min(1, (botSnap ? botSnap.textLength : 0) / renderedSnap.textLength);
        out.contentOverlap = jaccardSimilarity(botBodyText, renderedSnap.text);
      }

      // Challenge-page heuristic: short response that contains the patterns
      const isShort = botText.length < Math.max(2000, chromeLen * 0.4);
      const looksLikeChallenge = CHALLENGE_PATTERNS.some((p) => p.test(botText));
      if (isShort && looksLikeChallenge) {
        out.status = 'challenged';
        return out;
      }

      // Length-based classification vs Chrome
      if (chromeLen === 0) {
        // Chrome fetch failed — bot is the only data we have
        out.status = botText.length > 1000 ? 'no_cloaking' : 'fetch_failed';
      } else if (out.lengthRatio >= 1.2) {
        // Bot got materially MORE content — dynamic rendering
        out.status = 'dynamic_rendering';
      } else if (out.lengthRatio <= 0.5) {
        out.status = 'served_less';
      } else if (out.similarityToChrome >= 0.6) {
        out.status = 'no_cloaking';
      } else {
        // Similar length, low overlap — content drift specific to bot UA
        out.status = 'served_less';
      }

      // Stash the bot snapshot so promoteCanonicalBaseline can use it
      out._snap = botSnap;
      out._text = botText;
      return out;
    }

    // If a bot probe revealed dynamic rendering — i.e., the server sends bots
    // a richer response than browsers — recompute textRatio / contentOverlap
    // against the richest bot's response. That's the most charitable read,
    // and matches what an AI crawler actually consumes.
    maybePromoteCanonicalBaseline(renderedSnap) {
      const probes = this.analysis.botProbes.results || [];
      const dynamic = probes.filter((r) => r.status === 'dynamic_rendering' && r._snap && r._text);
      if (dynamic.length === 0) return;

      // Pick the bot with the longest response — the richest baseline
      dynamic.sort((a, b) => b.textLength - a.textLength);
      const winner = dynamic[0];
      const winnerSnap = winner._snap;

      const liveSnap = renderedSnap || this.analysis.server.rendered;
      if (!liveSnap || !winnerSnap) return;

      const newRatio = liveSnap.textLength > 0
        ? Math.min(1, winnerSnap.textLength / liveSnap.textLength)
        : (winnerSnap.textLength > 0 ? 1 : 0);
      const newOverlap = jaccardSimilarity(winnerSnap.text, liveSnap.text);

      // Only promote if it actually improves the picture
      const oldRatio = this.analysis.server.textRatio || 0;
      const oldOverlap = this.analysis.server.contentOverlap || 0;
      if (newRatio <= oldRatio && newOverlap <= oldOverlap) return;

      // Drop any low_server_visibility / content_drift / js_rendered_*
      // issues that were generated against the Chrome fetch — the bot
      // baseline supersedes them.
      const supersededTypes = new Set([
        'low_server_visibility',
        'low_content_overlap',
        'content_drift',
        'js_rendered_headings',
        'js_rendered_meta'
      ]);
      this.analysis.issues = this.analysis.issues.filter((i) => !supersededTypes.has(i.type));

      // Replace the canonical baseline
      this.analysis.server.canonicalSource = `bot:${winner.name}`;
      this.analysis.server.raw = winnerSnap;
      this.analysis.server.textRatio = newRatio;
      this.analysis.server.contentOverlap = newOverlap;
      this.analysis.server.visibilityRatio = newRatio;
      this.analysis.server.serverTextLength = winnerSnap.textLength;
      this.analysis.server.serverHeadings = winnerSnap.totalHeadings;
      this.analysis.server.linkRatio = liveSnap.totalLinks > 0
        ? Math.min(1, winnerSnap.totalLinks / liveSnap.totalLinks) : 0;
      this.analysis.server.headingRatio = liveSnap.totalHeadings > 0
        ? Math.min(1, winnerSnap.totalHeadings / liveSnap.totalHeadings) : 0;
    }

    // -------------------------------------------------------------------------
    // Segment classification — same vocabulary as the backend crawl reports
    // -------------------------------------------------------------------------

    classifySegment() {
      const s = this.analysis.server;
      if (!s || !s.fetched) {
        this.analysis.segment = 'unknown';
        return;
      }
      // Same MIN value that drives the headline percentage so the chip can't
      // disagree with the number. If contentOverlap is missing, fall back to
      // textRatio so we still pick a reasonable tier.
      const ratio = s.textRatio;
      const overlap = typeof s.contentOverlap === 'number' ? s.contentOverlap : ratio;
      const visibility = Math.min(ratio, overlap);

      for (const tier of SEGMENT_TIERS) {
        if (visibility >= tier.min) {
          this.analysis.segment = tier.key;
          return;
        }
      }
      this.analysis.segment = 'invisible';
    }

    consolidateRelatedIssues() {
      const ratio = this.analysis.server.fetched ? this.analysis.server.textRatio : null;
      const hasFwk = (this.analysis.details.frameworks || []).length > 0;
      if (hasFwk && ratio != null && ratio >= 0.6) {
        // Healthy server-render — framework presence isn't a problem.
      } else if (hasFwk && (ratio == null || ratio < 0.6)) {
        this.analysis.issues.push({
          type: 'js_framework_detected',
          severity: 'low',
          message: `JS framework: ${this.analysis.details.frameworks.join(', ')}`,
          impact: 'Without SSR, framework-rendered content is invisible to non-JS crawlers.',
          frameworks: this.analysis.details.frameworks,
          roiImpact: 0
        });
      }
    }

    computeScores() {
      const breakdown = {};

      // 1. Server visibility — blends text_ratio and content_overlap so
      //    "same length but different words" sites don't get full credit.
      if (this.analysis.server.fetched) {
        const r = this.analysis.server.textRatio;
        const o = this.analysis.server.contentOverlap;
        breakdown.serverVisibility = Math.round((r * 0.6 + o * 0.4) * 100);
      } else {
        breakdown.serverVisibility = null;
      }

      // 2. Crawler access — share of bots that can fetch THIS page.
      if (this.analysis.crawlers.fetched) {
        const total = this.analysis.crawlers.bots.length;
        const allowed = this.analysis.crawlers.bots.filter((b) => b.status === 'allowed').length;
        breakdown.crawlerAccess = Math.round((allowed / total) * 100);
      } else {
        breakdown.crawlerAccess = null;
      }

      // 3. Structured data
      const hasJsonLd = (this.analysis.details.jsonLdBlocks || 0) > 0;
      const hasMicro = !!this.analysis.details.hasMicrodata;
      const sitemap = this.analysis.aiSearchFiles.sitemapPresent || this.analysis.aiSearchFiles.sitemapDeclared;
      const llms = this.analysis.aiSearchFiles.llmsTxtPresent;
      let sd = 0;
      if (hasJsonLd) sd += 60;
      else if (hasMicro) sd += 30;
      if (sitemap) sd += 25;
      if (llms) sd += 15;
      breakdown.structuredData = Math.min(100, sd);

      // 4. Robots restrictions
      const restricted = this.analysis.issues.some(
        (i) => i.type === 'robots_meta_restrictive' || i.type === 'xrobots_restrictive'
      );
      breakdown.robotsRestrictions = restricted ? 0 : 100;

      let total = 0;
      let weight = 0;
      for (const k of Object.keys(SCORE_WEIGHTS)) {
        const v = breakdown[k];
        if (v == null) continue;
        total += v * SCORE_WEIGHTS[k];
        weight += SCORE_WEIGHTS[k];
      }
      let score = weight > 0 ? Math.round(total / weight) : 0;
      score = Math.max(0, Math.min(100, score));

      // Visibility cap: the score can never exceed how much of the page text
      // is in the server response. Other signals can drag below the cap but
      // not above it.
      if (this.analysis.server.fetched && typeof this.analysis.server.textRatio === 'number') {
        const cap = Math.round(this.analysis.server.textRatio * 100);
        score = Math.min(score, cap);
      }

      // Load-speed penalty (applied multiplicatively after the cap).
      //
      // Formula:   reduction = ((load - 2) / load) / 2   for load > 2s
      //   2s → 0%, 3s → 17%, 4s → 25%, 8s → 38%, asymptote 50%.
      // The /2 caps the penalty at half so a single slow signal can't zero
      // a score out — and reflects that we're not 100% sure load speed is
      // dispositive.
      const loadMs = this.analysis.performance.loadCompleteMs
        || this.analysis.performance.lcpMs;
      let loadPenalty = 0;
      if (loadMs != null) {
        const loadSec = loadMs / 1000;
        if (loadSec > 2) {
          loadPenalty = ((loadSec - 2) / loadSec) / 2;
          score = Math.round(score * (1 - loadPenalty));
        }
      }

      this.analysis.score = Math.max(0, Math.min(100, score));
      this.analysis.scoreBreakdown = breakdown;
      this.analysis.loadSpeedPenalty = loadPenalty;
    }

    // -------------------------------------------------------------------------
    // Recommendations
    // -------------------------------------------------------------------------

    generateRecommendations() {
      const has = (t) => this.analysis.issues.some((i) => i.type === t);

      if (has('low_server_visibility') || has('js_rendered_headings') || has('js_framework_detected') || has('js_rendered_meta')) {
        this.analysis.recommendations.push({
          priority: 'high',
          action: 'Server-render or pre-render the page',
          description: 'Use SSR (Next.js, Nuxt, SvelteKit), static generation, or a prerender service. Crawlers will see the content without running JavaScript.',
          resources: ['Next.js SSR', 'Nuxt.js', 'SvelteKit', 'Prerender.io']
        });
      }
      if (has('content_drift') || has('low_content_overlap')) {
        this.analysis.recommendations.push({
          priority: 'high',
          action: 'Align server HTML with the rendered content',
          description: 'The server is sending placeholder or different text than users see. Make sure your SSR or prerender output matches the live page.',
          resources: ['View raw HTML in DevTools', 'Compare with rendered']
        });
      }
      if (has('ai_crawlers_blocked_specific') || has('ai_crawlers_blocked_wildcard')) {
        this.analysis.recommendations.push({
          priority: 'high',
          action: 'Update robots.txt to allow AI crawlers',
          description: 'Many sites block AI crawlers by default. Decide which to allow (e.g., PerplexityBot, OAI-SearchBot for live browse) and which to block.',
          resources: ['robots.txt syntax', 'AI crawler list']
        });
      }
      if (has('xrobots_restrictive') || has('robots_meta_restrictive')) {
        this.analysis.recommendations.push({
          priority: 'high',
          action: 'Remove noindex / nofollow directives',
          description: 'Headers or meta tags are telling crawlers to skip this page.',
          resources: ['Robots meta tag guide']
        });
      }
      if (has('no_structured_data')) {
        this.analysis.recommendations.push({
          priority: 'medium',
          action: 'Add JSON-LD structured data',
          description: 'Add schema.org markup (Product, Article, Organization, FAQPage). Helps crawlers identify the page.',
          resources: ['Schema.org', 'JSON-LD generator']
        });
      }
      if (has('slow_ttfb')) {
        this.analysis.recommendations.push({
          priority: 'medium',
          action: 'Reduce time-to-first-byte',
          description: 'Crawlers with 2-second budgets quit on slow first bytes. Cache HTML at the edge, speed up the backend, or use a CDN.',
          resources: ['web.dev TTFB guide']
        });
      }
      if (has('slow_load')) {
        const loadMs = this.analysis.performance.loadCompleteMs || this.analysis.performance.lcpMs || 0;
        this.analysis.recommendations.push({
          priority: 'medium',
          action: 'Speed up page load',
          description: `Page took ${(loadMs / 1000).toFixed(1)}s to finish loading. Aim for under 2s. Optimize images, reduce render-blocking resources, prioritize above-the-fold content.`,
          resources: ['web.dev performance guide', 'Lighthouse']
        });
      }
      if (has('no_sitemap')) {
        this.analysis.recommendations.push({
          priority: 'low',
          action: 'Publish a sitemap.xml',
          description: 'Add /sitemap.xml, or declare one in robots.txt with a Sitemap: line. Helps crawlers find all your pages.',
          resources: ['sitemaps.org']
        });
      }
      if (has('no_canonical')) {
        this.analysis.recommendations.push({
          priority: 'low',
          action: 'Declare a canonical URL',
          description: 'Add <link rel="canonical"> or send a Link header so crawlers know which URL to index.',
          resources: ['canonical link guide']
        });
      }
      if (this.analysis.aiSearchFiles.llmsTxtPresent === false) {
        this.analysis.recommendations.push({
          priority: 'info',
          action: 'Consider adding /llms.txt',
          description: 'An emerging standard. Tells AI tools which of your pages matter, in markdown.',
          resources: ['llmstxt.org']
        });
      }
    }
  }

  function parseCanonicalLink(linkHeader) {
    if (!linkHeader) return null;
    const parts = linkHeader.split(',');
    for (const p of parts) {
      const m = p.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?canonical"?/i);
      if (m) return m[1].trim();
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------------------------

  async function runAnalysis(postHydration) {
    try {
      const analyzer = new Analyzer();
      const results = await analyzer.run();
      results.postHydration = !!postHydration;
      chrome.runtime.sendMessage({
        type: 'ANALYSIS_COMPLETE',
        data: results,
        url: window.location.href
      });
    } catch (error) {
      chrome.runtime.sendMessage({
        type: 'ANALYSIS_ERROR',
        error: (error && error.message) || String(error),
        url: window.location.href
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => runAnalysis(false));
  } else {
    runAnalysis(document.readyState === 'complete');
  }
})();
