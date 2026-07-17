// AI Search Visibility Checker - Background Service Worker
// Manages analysis state and coordinates between content script and popup.
// State lives in chrome.storage.session so it survives SW termination/restart
// within the browser session.

const STORAGE_PREFIX = 'tab:';
const tabKey = (tabId) => `${STORAGE_PREFIX}${tabId}`;
const RELOAD_ANALYSIS_PREFIX = 'reload-analysis:';
const reloadAnalysisKey = (tabId) => `${RELOAD_ANALYSIS_PREFIX}${tabId}`;
const LAST_RELOAD_PREFIX = 'last-reload:';
const lastReloadKey = (tabId) => `${LAST_RELOAD_PREFIX}${tabId}`;
const AUTO_RELOAD_COOLDOWN_MS = 60_000;

async function getStoredResult(tabId) {
  if (tabId === undefined || tabId === null) return null;
  const key = tabKey(tabId);
  const obj = await chrome.storage.session.get(key);
  return obj[key] || null;
}

async function setStoredResult(tabId, entry) {
  await chrome.storage.session.set({ [tabKey(tabId)]: entry });
}

async function clearStoredResult(tabId) {
  await chrome.storage.session.remove(tabKey(tabId));
}

async function setReloadAnalysisPending(tabId, pending) {
  const key = reloadAnalysisKey(tabId);
  if (pending) {
    await chrome.storage.session.set({ [key]: true });
  } else {
    await chrome.storage.session.remove(key);
  }
}

async function isReloadAnalysisPending(tabId) {
  const key = reloadAnalysisKey(tabId);
  const obj = await chrome.storage.session.get(key);
  return !!obj[key];
}

async function getLastReloadAt(tabId) {
  const key = lastReloadKey(tabId);
  const obj = await chrome.storage.session.get(key);
  return typeof obj[key] === 'number' ? obj[key] : 0;
}

async function setLastReloadAt(tabId, timestampMs) {
  await chrome.storage.session.set({ [lastReloadKey(tabId)]: timestampMs });
}

async function clearLastReloadAt(tabId) {
  await chrome.storage.session.remove(lastReloadKey(tabId));
}

async function injectAnalysisScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => { window.aiSearchVisibilityCheckerLoaded = false; }
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });
}

async function handleAnalysisComplete(analysisData, tabId) {
  if (tabId === undefined) return;
  const entry = {
    type: 'ok',
    results: { ...analysisData, timestamp: Date.now() }
  };
  await setStoredResult(tabId, entry);
  await updateBadge(tabId, entry);
}

async function handleAnalysisError(errorMessage, tabId) {
  if (tabId === undefined) return;
  const entry = {
    type: 'error',
    error: errorMessage || 'Analysis failed',
    timestamp: Date.now()
  };
  await setStoredResult(tabId, entry);
  await clearBadge(tabId);
}

async function updateBadge(tabId, entry) {
  if (!entry || entry.type !== 'ok' || !entry.results) return;
  const results = entry.results;

  // Keep badge colors aligned with the popup's segment semantics.
  const segment = results.segment;
  const server = results.server || {};
  const textRatio = typeof server.textRatio === 'number' ? server.textRatio : null;
  const overlap = typeof server.contentOverlap === 'number' ? server.contentOverlap : textRatio;
  const visibilityPct = textRatio == null || overlap == null
    ? null
    : Math.round(Math.min(textRatio, overlap) * 100);

  let badgeText = '';
  let badgeColor = '';
  if (segment === 'fully_accessible' || segment === 'mostly_visible') {
    badgeText = '✓';
    badgeColor = '#00AA00';
  } else if (segment === 'partially_accessible' || segment === 'slipping') {
    badgeText = '!';
    badgeColor = '#FFA500';
  } else if (segment === 'js_dependent') {
    badgeText = '✗';
    badgeColor = '#FF0000';
  } else if (segment === 'invisible') {
    badgeText = '✗';
    badgeColor = '#8B0000';
  } else if (typeof results.score === 'number') {
    // Fallback for older payloads without segment.
    if (results.score >= 80) {
      badgeText = '✓';
      badgeColor = '#00AA00';
    } else if (results.score >= 50) {
      badgeText = '!';
      badgeColor = '#FFA500';
    } else {
      badgeText = '✗';
      badgeColor = '#FF0000';
    }
  } else {
    return;
  }

  await chrome.action.setBadgeText({ text: badgeText, tabId });
  await chrome.action.setBadgeBackgroundColor({ color: badgeColor, tabId });
  await chrome.action.setTitle({
    title: visibilityPct == null
      ? `AI Search Visibility Score: ${results.score}/100`
      : `AI Search Visibility: ${visibilityPct}%`,
    tabId
  });
}

async function clearBadge(tabId) {
  try {
    await chrome.action.setBadgeText({ text: '', tabId });
    await chrome.action.setTitle({ title: 'Check AI Search Visibility', tabId });
  } catch (_) {
    // Tab may have closed; ignore.
  }
}

// Content scripts are subject to the host page's connect-src CSP, so we route
// fetches through the SW instead. Truncates very large bodies to keep messages
// well under the chrome.runtime message size limit.
const MAX_BODY_BYTES = 2_000_000;
const DEFAULT_FETCH_TIMEOUT_MS = 6000;

// Single session rule ID reused across sequential bot probes. We always
// remove-then-add so concurrent probes can't see each other's UA.
const PROBE_RULE_ID = 1;
const PROBE_RULE_LOCK = { busy: false, queue: [] };

// Serialize probe requests so a stale rule from a prior probe can't leak into
// the next one. Each waiter resolves after the previous probe finishes.
function acquireProbeLock() {
  return new Promise((resolve) => {
    if (!PROBE_RULE_LOCK.busy) {
      PROBE_RULE_LOCK.busy = true;
      resolve();
    } else {
      PROBE_RULE_LOCK.queue.push(resolve);
    }
  });
}
function releaseProbeLock() {
  const next = PROBE_RULE_LOCK.queue.shift();
  if (next) next();
  else PROBE_RULE_LOCK.busy = false;
}

// Install a DNR session rule that rewrites the User-Agent header for the
// specific URL we're about to probe. Scoped to xmlhttprequest so the user's
// regular page navigation isn't affected. Rule is removed in `finally`.
async function probeUrlAs(url, userAgent, timeoutMs) {
  await acquireProbeLock();
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [PROBE_RULE_ID],
      addRules: [{
        id: PROBE_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'User-Agent', operation: 'set', value: userAgent }
          ]
        },
        condition: {
          // Anchored exact-URL match: leading | + url + trailing | means
          // "request URL is exactly this string."
          urlFilter: '|' + url + '|',
          resourceTypes: ['xmlhttprequest']
        }
      }]
    });

    return await fetchUrl(url, timeoutMs);
  } catch (error) {
    return {
      ok: false,
      error: (error && error.message) || String(error)
    };
  } finally {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [PROBE_RULE_ID]
      });
    } catch (_) { /* ignore — rule may already be gone */ }
    releaseProbeLock();
  }
}

async function fetchUrl(url, timeoutMs) {
  const timeout = typeof timeoutMs === 'number' && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal
    });
    let text = await response.text();
    let truncated = false;
    if (text.length > MAX_BODY_BYTES) {
      text = text.slice(0, MAX_BODY_BYTES);
      truncated = true;
    }
    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return {
      ok: true,
      status: response.status,
      redirected: response.redirected,
      finalUrl: response.url,
      headers,
      text,
      truncated
    };
  } catch (error) {
    return {
      ok: false,
      error: error && error.name === 'AbortError' ? 'timeout' : (error && error.message) || String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ANALYSIS_COMPLETE') {
    handleAnalysisComplete(message.data, sender.tab && sender.tab.id)
      .finally(() => sendResponse({ success: true }));
    return true;
  }
  if (message.type === 'ANALYSIS_ERROR') {
    handleAnalysisError(message.error, sender.tab && sender.tab.id)
      .finally(() => sendResponse({ success: true }));
    return true;
  }
  if (message.type === 'GET_ANALYSIS') {
    getStoredResult(message.tabId).then((entry) => {
      sendResponse(entry || {});
    });
    return true;
  }
  if (message.type === 'CLEAR_ANALYSIS') {
    Promise.all([
      clearStoredResult(message.tabId),
      clearBadge(message.tabId),
      setReloadAnalysisPending(message.tabId, false),
      clearLastReloadAt(message.tabId)
    ]).finally(() => sendResponse({ success: true }));
    return true;
  }
  if (message.type === 'START_RELOAD_ANALYSIS') {
    (async () => {
      try {
        const tabId = message.tabId;
        if (tabId === undefined || tabId === null) {
          sendResponse({ success: false, error: 'missing-tab-id' });
          return;
        }
        const now = Date.now();
        const lastReloadAt = await getLastReloadAt(tabId);
        const shouldReload = now - lastReloadAt >= AUTO_RELOAD_COOLDOWN_MS;

        await Promise.all([
          clearStoredResult(tabId),
          clearBadge(tabId),
          setReloadAnalysisPending(tabId, shouldReload)
        ]);
        if (shouldReload) {
          await setLastReloadAt(tabId, now);
          await chrome.tabs.reload(tabId);
        } else {
          await injectAnalysisScript(tabId);
        }
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({
          success: false,
          error: (error && error.message) || String(error)
        });
      }
    })();
    return true;
  }
  if (message.type === 'FETCH_URL') {
    fetchUrl(message.url, message.timeoutMs).then((result) => sendResponse(result));
    return true;
  }
  if (message.type === 'PROBE_URL') {
    probeUrlAs(message.url, message.userAgent, message.timeoutMs)
      .then((result) => sendResponse(result));
    return true;
  }
  return false;
});

// Clear cached result + badge when a tab navigates to a new URL.
// changeInfo.url is set when the URL changes (covers SPA in-page changes too).
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.url) {
    await clearStoredResult(tabId);
    await clearBadge(tabId);
  }
  if (changeInfo.status === 'loading') {
    const pending = await isReloadAnalysisPending(tabId);
    if (!pending) return;
    await setReloadAnalysisPending(tabId, false);
    try {
      await injectAnalysisScript(tabId);
    } catch (_) {
      await handleAnalysisError('This page can’t be analyzed by the extension.', tabId);
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearStoredResult(tabId);
  setReloadAnalysisPending(tabId, false);
  clearLastReloadAt(tabId);
});

// On SW startup, defensively clear any stale UA-override session rule. Session
// rules normally clear on browser exit, but if an SW died mid-probe the rule
// could outlive the analysis it was scoped to.
(async () => {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [PROBE_RULE_ID]
    });
  } catch (_) { /* nothing to clear */ }
})();
