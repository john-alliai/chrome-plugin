# Phase II: Shadow Query Analyzer Integration

## Overview

Integrate a "Shadow Query Analyzer" feature into the existing AI Search Visibility Checker Chrome extension. This feature reveals the hidden search queries that ChatGPT generates internally before searching the web to answer a user's question. These are commonly called "shadow queries" in the SEO community.

**Strategic value:** Users discover the exact queries ChatGPT uses behind the scenes → they realize they have no content ranking for those queries → natural lead-in to Alli AI's AI Search Visibility Engine.

---

## How the Bookmarklet Currently Works

The existing bookmarklet (William's script) operates by:

1. Running **inside a ChatGPT browser tab** (requires active session)
2. Grabbing the user's auth token from `/api/auth/session`
3. Calling ChatGPT's internal API: `/backend-api/conversation/{conversation_id}`
4. Parsing the response to extract `search_model_queries` and `search_queries` from message metadata
5. Also extracts: cited sources, footnotes, entities, image groups, model info
6. Renders everything in a new popup window

**Key constraint:** The ChatGPT internal API only works from the `chatgpt.com` origin due to cookies/CORS. A Chrome extension with proper permissions can make this same call.

---

## What Needs to Change

### 1. `manifest.json`

**Current state:** Generic `<all_urls>` content script, basic permissions.

**Required changes:**

```json
{
  "permissions": [
    "activeTab",
    "scripting",
    "tabs",
    "storage"           // NEW: persist shadow query history
  ],
  "host_permissions": [
    "https://chatgpt.com/*"  // NEW: needed to access ChatGPT API
  ],
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_start"
    },
    {
      "matches": ["https://chatgpt.com/*"],   // NEW: ChatGPT-specific
      "js": ["chatgpt-content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

**Why:** The extension needs explicit permission to interact with ChatGPT's domain and make authenticated API calls using the user's existing session cookies.

---

### 2. New File: `chatgpt-content.js`

**Purpose:** Detects when the user is on ChatGPT, extracts conversation ID, fetches shadow queries via the internal API.

**Core logic to port from bookmarklet:**

```
1. Extract conversation ID from URL: /c/{conversation_id}
2. Fetch auth token: GET /api/auth/session → accessToken
3. Fetch conversation data: GET /backend-api/conversation/{id}
   - Headers: Authorization: Bearer {token}
4. Parse response.mapping → iterate message nodes
5. Extract from each message's metadata:
   - search_model_queries.queries → shadow queries (marked as hidden)
   - search_queries → visible search queries
   - content_references → cited sources, footnotes
   - search_result_groups → grouped citations
6. Map each query set back to its parent user prompt
7. Send extracted data to background.js via chrome.runtime.sendMessage
```

**Key data structure to extract:**

```javascript
{
  userPrompt: "drug rehab new jersey",
  shadowQueries: [
    { text: "best drug rehab centers new jersey", hidden: true },
    { text: "top rated addiction treatment NJ", hidden: true },
    { text: "drug rehab new jersey reviews", hidden: false }
  ],
  citations: [
    { title: "...", url: "...", type: "Primary Citation", refIndex: 1 },
    // ...
  ],
  model: "gpt-4o"
}
```

**Trigger options (pick one or support both):**
- **Automatic:** Detect URL change/conversation load on chatgpt.com, extract on page idle
- **Manual:** User clicks extension icon or a button injected into the ChatGPT UI

**Recommendation:** Start with manual trigger (user clicks extension icon while on ChatGPT). Less intrusive, fewer edge cases.

---

### 3. `background.js` Modifications

**Current state:** `AnalysisManager` class stores visibility scores per tab.

**Required changes:**

- Add a second data store alongside `analysisResults`:

```javascript
this.shadowQueryResults = new Map(); // Store shadow queries by tab ID
```

- Add new message handlers:

```javascript
// In setupMessageHandlers():
case 'SHADOW_QUERIES_COMPLETE':
  this.shadowQueryResults.set(sender.tab.id, message.data);
  this.updateBadge(sender.tab.id); // Update badge to show SQ indicator
  sendResponse({ success: true });
  break;

case 'GET_SHADOW_QUERIES':
  const sqResults = this.shadowQueryResults.get(message.tabId);
  sendResponse({ results: sqResults });
  break;
```

- Update `updateBadge()` to show a different indicator when on ChatGPT (e.g., "SQ" badge text in Alli green).

---

### 4. `popup.html` Modifications

**Current state:** Single-view popup showing visibility score, issues, recommendations, ROI.

**Required changes:**

Add a **tab/view switcher** at the top of the popup:

```
┌─────────────────────────────────┐
│  [AI Visibility]  [Shadow Q's]  │  ← Tab switcher
├─────────────────────────────────┤
│                                 │
│  (content changes based on tab) │
│                                 │
└─────────────────────────────────┘
```

**AI Visibility tab** (existing): Score, issues, recommendations, ROI — no changes.

**Shadow Queries tab** (new): Shows extracted shadow queries for the current ChatGPT conversation.

**Shadow Queries tab UI structure:**

```
User Prompt: "drug rehab new jersey"

Shadow Queries (5):
  ┌ "best drug rehab centers new jersey"         [Copy]
  ├ "top rated addiction treatment NJ"            [Copy]
  ├ "drug rehabilitation programs new jersey"     [Copy]
  ├ "inpatient drug rehab NJ reviews"             [Copy]
  └ "affordable drug rehab near new jersey"       [Copy]

Sources Cited (3):
  1. rehabs.com/drug-rehab/new-jersey
  2. drugabuse.com/treatment/new-jersey
  3. addictioncenter.com/treatment/nj

[Copy All Queries]                    ← Bulk copy button
[Export CSV]                          ← Download as CSV

─────────────────────────────────────
🔍 Want to rank for these queries?
[See How Alli AI Can Help →]          ← CTA to alliai.com
```

**Conditional display logic:**
- If user is on `chatgpt.com` → Shadow Queries tab is active/default, show data or prompt to analyze
- If user is on any other site → AI Visibility tab is active/default
- If on ChatGPT but no conversation open → Show instruction: "Open a ChatGPT conversation with web search results, then click Analyze"

---

### 5. `popup.js` Modifications

**Current state:** `PopupManager` class handles single-view results display.

**Required changes:**

- Detect current tab URL to determine which view to show:

```javascript
async init() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  this.currentTab = tabs[0];
  this.currentTabId = tabs[0].id;

  const isChatGPT = this.currentTab.url?.includes('chatgpt.com');
  this.setupTabSwitcher(isChatGPT);

  if (isChatGPT) {
    this.showShadowQueryView();
  } else {
    this.showVisibilityView(); // existing behavior
  }
}
```

- Add `ShadowQueryView` class or methods:
  - `loadShadowQueries()` — request from background.js
  - `displayShadowQueries(data)` — render the query list
  - `handleCopyAll()` — copy all queries to clipboard
  - `handleExportCSV()` — generate and download CSV
  - `triggerShadowAnalysis()` — tell chatgpt-content.js to extract

---

### 6. Popup Width

**Current:** `width: 380px` in popup.html CSS.

**Recommendation:** Increase to `width: 440px` to accommodate shadow query list with copy buttons. The AI Visibility view works fine at 380px, so only expand when Shadow Queries tab is active, or just set 420px as a comfortable default for both.

---

## New Files Summary

| File | Purpose |
|------|---------|
| `chatgpt-content.js` | Content script that runs on chatgpt.com, extracts shadow queries via internal API |
| `shadow-query-view.js` | (Optional) Separate JS module for shadow query popup UI logic |

## Modified Files Summary

| File | Changes |
|------|---------|
| `manifest.json` | Add `storage` permission, `chatgpt.com` host permission, new content script entry |
| `background.js` | Add shadow query data store, new message handlers, badge logic for ChatGPT tabs |
| `popup.html` | Add tab switcher UI, shadow queries view HTML, updated styles |
| `popup.js` | Add URL detection, tab switching, shadow query display/copy/export logic |

---

## CTA & Lead Generation Integration

The shadow query results should funnel users toward Alli AI:

1. **In-popup CTA:** "Want to rank for these shadow queries? → See How Alli AI Can Help" linking to `alliai.com/shadow-queries` or a dedicated landing page
2. **Export includes branding:** CSV export header includes "Generated by Alli AI Shadow Query Analyzer — alliai.com"
3. **Share feature (future):** "Share this analysis" generates a branded report link

---

## Edge Cases to Handle

| Scenario | Handling |
|----------|----------|
| User is on ChatGPT but not logged in | Show message: "Log in to ChatGPT to analyze shadow queries" |
| Conversation has no web search queries | Show message: "This conversation didn't trigger web searches. Try a query that would require current information." |
| ChatGPT API changes endpoints or auth | Version the API calls, add error handling with user-friendly fallback message |
| User has multiple conversations open | Extract from the currently visible conversation (URL-based) |
| Rate limiting from ChatGPT API | Add debounce, cache results per conversation ID |
| Session token expired | Detect 401/403 response, prompt user to refresh ChatGPT page |

---

## Chrome Web Store Considerations

- **Privacy policy update needed:** Disclose that the extension reads ChatGPT conversation data (only when user initiates analysis)
- **Permissions justification:** Chrome Web Store review will ask why `chatgpt.com` host permission is needed — prepare clear explanation
- **No data leaves the browser:** Shadow query data should stay local (or optionally export). Don't send to Alli AI servers without explicit consent.

---

## Implementation Order

1. **`chatgpt-content.js`** — Port the core extraction logic from the bookmarklet. Test standalone.
2. **`background.js`** — Add shadow query message handlers and storage.
3. **`manifest.json`** — Add permissions and content script entry.
4. **`popup.html` + `popup.js`** — Build the shadow query tab UI and wire it up.
5. **Test end-to-end** — Verify on live ChatGPT conversations with web search results.
6. **Polish** — Alli AI branding, CTA integration, CSV export, copy functionality.

---

## Future Enhancements (Phase III+)

- **Gemini support:** Similar extraction for Google Gemini's grounding queries
- **Perplexity support:** Extract Perplexity's search queries if API allows
- **Query history:** Store shadow queries across sessions using `chrome.storage`
- **Trend analysis:** "You've analyzed 50 queries this month — here are the most common themes"
- **Content gap report:** Compare shadow queries against user's site content (requires site crawl or Alli AI integration)
- **In-page overlay on ChatGPT:** Inject a small panel directly into the ChatGPT UI showing shadow queries inline, rather than requiring popup click
