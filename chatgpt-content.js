// Shadow Query Analyzer - ChatGPT Content Script
// Extracts shadow queries from ChatGPT conversations via internal API
// Only runs on chatgpt.com

(function () {
  if (window.__shadowQueryAnalyzerLoaded) return;
  window.__shadowQueryAnalyzerLoaded = true;

  class ShadowQueryExtractor {
    constructor() {
      this.conversationId = null;
      this.accessToken = null;
    }

    // Extract conversation ID from ChatGPT URL: /c/{id} or /g/{id} patterns
    getConversationIdFromURL() {
      const match = window.location.pathname.match(/\/(?:c|g)\/([a-f0-9-]+)/);
      return match ? match[1] : null;
    }

    // Fetch the user's auth token from ChatGPT's session endpoint
    async fetchAccessToken() {
      try {
        const response = await fetch('/api/auth/session', {
          credentials: 'include'
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            throw new Error('NOT_LOGGED_IN');
          }
          throw new Error(`Session fetch failed: ${response.status}`);
        }
        const data = await response.json();
        if (!data.accessToken) {
          throw new Error('NOT_LOGGED_IN');
        }
        return data.accessToken;
      } catch (error) {
        if (error.message === 'NOT_LOGGED_IN') throw error;
        throw new Error(`AUTH_FAILED: ${error.message}`);
      }
    }

    // Fetch full conversation data from ChatGPT's internal API
    async fetchConversation(conversationId, accessToken) {
      const response = await fetch(
        `/backend-api/conversation/${conversationId}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          credentials: 'include'
        }
      );

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error('TOKEN_EXPIRED');
        }
        if (response.status === 429) {
          throw new Error('RATE_LIMITED');
        }
        throw new Error(`Conversation fetch failed: ${response.status}`);
      }

      return response.json();
    }

    // Normalize a search_model_queries or search_queries field into a flat array
    normalizeQueryField(field) {
      if (!field) return [];
      // Direct array: ["q1", "q2"] or [{text:"q1"}, ...]
      if (Array.isArray(field)) return field;
      // Object with .queries: { queries: [...] }
      if (field.queries && Array.isArray(field.queries)) return field.queries;
      // Object with .items: { items: [...] }
      if (field.items && Array.isArray(field.items)) return field.items;
      return [];
    }

    // Extract query strings from a normalized array of mixed strings/objects
    extractQueryStrings(arr) {
      const strings = [];
      for (const q of arr) {
        if (typeof q === 'string' && q.trim()) {
          strings.push(q.trim());
        } else if (q && typeof q === 'object') {
          const text = q.text || q.query || q.q || q.search_query || '';
          if (text.trim()) strings.push(text.trim());
        }
      }
      return strings;
    }

    // Parse conversation data to extract shadow queries, citations, and model info
    parseConversation(conversationData) {
      const mapping = conversationData.mapping;
      if (!mapping) return [];

      // First pass: collect search data from ALL message types into a map keyed
      // by the nearest ancestor user prompt. Search metadata can live on:
      //   - assistant messages (older format)
      //   - tool messages with author.name "web", "browser", "search", etc.
      //   - assistant messages with recipient "web" (tool-call initiation)
      const promptGroups = new Map(); // userPrompt -> { shadowQueries, visibleQueries, citations, model }

      for (const node of Object.values(mapping)) {
        const message = node.message;
        if (!message) continue;

        const role = message.author?.role;
        const authorName = (message.author?.name || '').toLowerCase();
        const metadata = message.metadata || {};
        const recipient = message.recipient || metadata.recipient || '';

        // Collect shadow queries (search_model_queries) from metadata
        const rawShadow = this.normalizeQueryField(metadata.search_model_queries);
        const shadowStrings = this.extractQueryStrings(rawShadow);

        // Collect visible queries (search_queries) from metadata
        const rawVisible = this.normalizeQueryField(metadata.search_queries);
        const visibleStrings = this.extractQueryStrings(rawVisible);

        // Also check metadata.args for search queries (some formats)
        if (metadata.args && !shadowStrings.length && !visibleStrings.length) {
          const argsQueries = this.normalizeQueryField(metadata.args);
          const argsStrings = this.extractQueryStrings(argsQueries);
          if (argsStrings.length > 0) {
            shadowStrings.push(...argsStrings);
          }
        }

        // Check content.parts for search query objects
        const parts = message.content?.parts || [];
        for (const part of parts) {
          if (part && typeof part === 'object') {
            // Some formats embed queries in content parts
            if (part.search_queries) {
              const pq = this.normalizeQueryField(part.search_queries);
              visibleStrings.push(...this.extractQueryStrings(pq));
            }
            if (part.search_model_queries) {
              const pq = this.normalizeQueryField(part.search_model_queries);
              shadowStrings.push(...this.extractQueryStrings(pq));
            }
          }
        }

        // Check for search content in tool messages (tether_browsing_display, etc.)
        const contentType = message.content?.content_type || '';
        if (contentType === 'tether_browsing_display' || contentType === 'tether_quote') {
          // Search result content — may contain result data
          const result = message.content?.result;
          if (result && typeof result === 'string') {
            // Sometimes result is JSON stringified
            try {
              const parsed = JSON.parse(result);
              if (parsed.search_model_queries) {
                shadowStrings.push(...this.extractQueryStrings(
                  this.normalizeQueryField(parsed.search_model_queries)
                ));
              }
              if (parsed.search_queries) {
                visibleStrings.push(...this.extractQueryStrings(
                  this.normalizeQueryField(parsed.search_queries)
                ));
              }
            } catch (e) { /* not JSON, skip */ }
          }
        }

        // Extract citations from this message
        const citations = this.extractCitations(metadata, message);

        // Skip if this message has no search data at all
        if (shadowStrings.length === 0 && visibleStrings.length === 0 && citations.length === 0) {
          continue;
        }

        // Find the user prompt that triggered this search
        const userPrompt = this.findParentUserPrompt(node, mapping);

        // Get model info
        const model = metadata.model_slug || conversationData.model || 'unknown';

        // Merge into prompt group
        if (!promptGroups.has(userPrompt)) {
          promptGroups.set(userPrompt, {
            shadowStrings: [],
            visibleStrings: [],
            citations: [],
            model: model
          });
        }
        const group = promptGroups.get(userPrompt);
        group.shadowStrings.push(...shadowStrings);
        group.visibleStrings.push(...visibleStrings);
        group.citations.push(...citations);
      }

      // Second pass: deduplicate and build result objects
      const results = [];
      for (const [userPrompt, group] of promptGroups) {
        const shadowQueries = [];
        const seenLower = new Set();

        // Shadow queries first (hidden)
        for (const text of group.shadowStrings) {
          const lower = text.toLowerCase();
          if (!seenLower.has(lower)) {
            seenLower.add(lower);
            shadowQueries.push({ text, hidden: true });
          }
        }

        // Visible queries (only add if not already present as shadow)
        for (const text of group.visibleStrings) {
          const lower = text.toLowerCase();
          if (!seenLower.has(lower)) {
            seenLower.add(lower);
            shadowQueries.push({ text, hidden: false });
          }
        }

        // Deduplicate citations by URL
        const seenUrls = new Set();
        const uniqueCitations = [];
        for (const c of group.citations) {
          const key = c.url || c.title;
          if (!seenUrls.has(key)) {
            seenUrls.add(key);
            uniqueCitations.push({ ...c, refIndex: uniqueCitations.length + 1 });
          }
        }

        if (shadowQueries.length > 0 || uniqueCitations.length > 0) {
          results.push({
            userPrompt,
            shadowQueries,
            citations: uniqueCitations,
            model: group.model
          });
        }
      }

      return results;
    }

    // Walk up the tree to find the user prompt that triggered a search
    findParentUserPrompt(assistantNode, mapping) {
      // The parent ID points to the previous node in the conversation
      let currentId = assistantNode.parent;
      const visited = new Set();

      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const node = mapping[currentId];
        if (!node || !node.message) {
          currentId = node?.parent;
          continue;
        }

        if (node.message.author?.role === 'user') {
          const parts = node.message.content?.parts || [];
          return parts
            .filter((p) => typeof p === 'string')
            .join(' ')
            .trim();
        }

        currentId = node.parent;
      }

      return '(unknown prompt)';
    }

    // Extract citations from message metadata and content
    extractCitations(metadata, message) {
      const citations = [];
      const seenUrls = new Set();

      const addCitation = (title, url, type) => {
        if (!url && !title) return;
        const key = url || title;
        if (seenUrls.has(key)) return;
        seenUrls.add(key);
        citations.push({
          title: title || url || 'Untitled',
          url: url || '',
          type: type || 'Citation',
          refIndex: citations.length + 1
        });
      };

      // content_references (newer format)
      const contentRefs = metadata.content_references || [];
      for (const ref of contentRefs) {
        addCitation(ref.title, ref.url, ref.type || 'Citation');
      }

      // _cite_metadata (alternative newer format)
      const citeMeta = metadata._cite_metadata;
      if (citeMeta) {
        const citeRefs = citeMeta.citation_format?.citations ||
                         citeMeta.citations || [];
        for (const ref of citeRefs) {
          addCitation(ref.title, ref.url || ref.href, 'Citation');
        }
        // Also check metadata_list inside _cite_metadata
        const metaList = citeMeta.metadata_list || [];
        for (const ref of metaList) {
          addCitation(ref.title, ref.url, 'Citation');
        }
      }

      // search_result_groups (older/alternative format)
      const searchResultGroups = metadata.search_result_groups || [];
      for (const group of searchResultGroups) {
        const entries = group.search_results || group.entries || [];
        for (const entry of entries) {
          addCitation(entry.title, entry.url, 'Search Result');
        }
      }

      // Check content parts for citations
      const parts = message.content?.parts || [];
      for (const part of parts) {
        if (part && typeof part === 'object') {
          // Footnote-style citations
          if (part.content_type === 'cite' && part.url) {
            addCitation(part.title, part.url, 'Footnote');
          }
          // Tether-style citations in browsing results
          if (part.url && part.title) {
            addCitation(part.title, part.url, 'Source');
          }
        }
      }

      // Check content.result for search result groups (tether_browsing_display)
      const contentResult = message.content?.result;
      if (contentResult && typeof contentResult === 'string') {
        try {
          const parsed = JSON.parse(contentResult);
          const groups = parsed.groups || parsed.search_result_groups || [];
          for (const group of groups) {
            const entries = group.entries || group.search_results || [];
            for (const entry of entries) {
              addCitation(entry.title, entry.url, 'Search Result');
            }
          }
        } catch (e) { /* not JSON, skip */ }
      }

      return citations;
    }

    // Build a debug summary of conversation structure to diagnose parsing issues
    buildDebugSummary(conversationData) {
      const mapping = conversationData.mapping;
      if (!mapping) return { error: 'no mapping' };

      const messages = [];
      for (const [nodeId, node] of Object.entries(mapping)) {
        const msg = node.message;
        if (!msg) continue;

        const meta = msg.metadata || {};
        const metaKeys = Object.keys(meta);
        const contentType = msg.content?.content_type || 'none';
        const contentKeys = msg.content ? Object.keys(msg.content) : [];

        const summary = {
          role: msg.author?.role,
          authorName: msg.author?.name || null,
          recipient: msg.recipient || meta.recipient || null,
          contentType: contentType,
          contentKeys: contentKeys,
          metadataKeys: metaKeys,
          hasSearchModelQueries: !!meta.search_model_queries,
          hasSearchQueries: !!meta.search_queries,
          hasCiteMetadata: !!meta._cite_metadata,
          hasContentReferences: !!meta.content_references,
          hasSearchResultGroups: !!meta.search_result_groups,
        };

        // Include search_model_queries structure hint
        if (meta.search_model_queries) {
          const smq = meta.search_model_queries;
          summary.searchModelQueriesType = Array.isArray(smq) ? 'array' : typeof smq;
          if (Array.isArray(smq)) {
            summary.searchModelQueriesSample = smq.slice(0, 2);
          } else if (typeof smq === 'object') {
            summary.searchModelQueriesKeys = Object.keys(smq);
          }
        }

        // Include search_queries structure hint
        if (meta.search_queries) {
          const sq = meta.search_queries;
          summary.searchQueriesType = Array.isArray(sq) ? 'array' : typeof sq;
          if (Array.isArray(sq)) {
            summary.searchQueriesSample = sq.slice(0, 2);
          } else if (typeof sq === 'object') {
            summary.searchQueriesKeys = Object.keys(sq);
          }
        }

        // Check if content_references has data
        if (meta.content_references) {
          summary.contentReferencesCount = Array.isArray(meta.content_references)
            ? meta.content_references.length : 'not-array';
        }

        messages.push(summary);
      }

      return {
        totalMessages: messages.length,
        messages: messages
      };
    }

    // Main extraction method - called by popup or on manual trigger
    async extract() {
      // Get conversation ID from URL
      this.conversationId = this.getConversationIdFromURL();
      if (!this.conversationId) {
        return {
          success: false,
          error: 'NO_CONVERSATION',
          message:
            'Open a ChatGPT conversation with web search results, then click Analyze.'
        };
      }

      try {
        // Fetch auth token
        this.accessToken = await this.fetchAccessToken();
      } catch (error) {
        if (error.message === 'NOT_LOGGED_IN') {
          return {
            success: false,
            error: 'NOT_LOGGED_IN',
            message: 'Log in to ChatGPT to analyze shadow queries.'
          };
        }
        return {
          success: false,
          error: 'AUTH_FAILED',
          message: 'Could not authenticate with ChatGPT. Try refreshing the page.'
        };
      }

      try {
        // Fetch conversation data
        const conversationData = await this.fetchConversation(
          this.conversationId,
          this.accessToken
        );

        // Build a debug summary of all message types and metadata keys
        // to help diagnose parsing issues
        const debugInfo = this.buildDebugSummary(conversationData);

        // Parse and extract shadow queries
        const queryResults = this.parseConversation(conversationData);

        if (queryResults.length === 0) {
          return {
            success: true,
            error: 'NO_SEARCH_QUERIES',
            message:
              "This conversation didn't trigger web searches. Try a query that would require current information.",
            data: {
              conversationId: this.conversationId,
              results: [],
              totalShadowQueries: 0,
              totalCitations: 0,
              debug: debugInfo
            }
          };
        }

        // Aggregate stats
        const totalShadowQueries = queryResults.reduce(
          (sum, r) => sum + r.shadowQueries.length,
          0
        );
        const totalCitations = queryResults.reduce(
          (sum, r) => sum + r.citations.length,
          0
        );

        return {
          success: true,
          data: {
            conversationId: this.conversationId,
            results: queryResults,
            totalShadowQueries: totalShadowQueries,
            totalCitations: totalCitations,
            extractedAt: Date.now(),
            debug: debugInfo
          }
        };
      } catch (error) {
        if (error.message === 'TOKEN_EXPIRED') {
          return {
            success: false,
            error: 'TOKEN_EXPIRED',
            message:
              'Your ChatGPT session has expired. Refresh the page and try again.'
          };
        }
        if (error.message === 'RATE_LIMITED') {
          return {
            success: false,
            error: 'RATE_LIMITED',
            message:
              'Too many requests. Wait a moment and try again.'
          };
        }
        return {
          success: false,
          error: 'EXTRACTION_FAILED',
          message: `Failed to extract shadow queries: ${error.message}`
        };
      }
    }
  }

  // Listen for messages from popup/background to trigger extraction
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'EXTRACT_SHADOW_QUERIES') {
      const extractor = new ShadowQueryExtractor();
      extractor.extract().then((result) => {
        // Also send to background for caching
        if (result.success && result.data) {
          chrome.runtime.sendMessage({
            type: 'SHADOW_QUERIES_COMPLETE',
            data: result.data
          });
        }
        sendResponse(result);
      });
      return true; // Keep message channel open for async response
    }
  });
})();
