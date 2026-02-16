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

    // Parse conversation data to extract shadow queries, citations, and model info
    parseConversation(conversationData) {
      const mapping = conversationData.mapping;
      if (!mapping) return [];

      const results = [];

      // Build a map of message IDs to their content for linking user prompts
      const messageNodes = Object.values(mapping);

      // Find user messages and their subsequent assistant messages with search queries
      for (const node of messageNodes) {
        const message = node.message;
        if (!message) continue;

        // We want assistant messages that have search metadata
        if (message.author?.role !== 'assistant') continue;

        const metadata = message.metadata || {};

        // Extract shadow queries from search_model_queries
        const searchModelQueries = metadata.search_model_queries?.queries || [];
        // Extract visible search queries
        const searchQueries = metadata.search_queries || [];

        // Skip if no search activity
        if (searchModelQueries.length === 0 && searchQueries.length === 0) continue;

        // Find the parent user prompt
        const userPrompt = this.findParentUserPrompt(
          node,
          mapping
        );

        // Build shadow query objects
        const shadowQueries = [];

        // search_model_queries are the hidden/shadow queries
        for (const q of searchModelQueries) {
          const queryText = typeof q === 'string' ? q : q.text || q.query || '';
          if (queryText) {
            shadowQueries.push({ text: queryText, hidden: true });
          }
        }

        // search_queries are the visible queries (also useful)
        for (const q of searchQueries) {
          const queryText = typeof q === 'string' ? q : q.text || q.query || '';
          if (queryText) {
            // Check if already in shadow queries
            const isDuplicate = shadowQueries.some(
              (sq) => sq.text.toLowerCase() === queryText.toLowerCase()
            );
            if (!isDuplicate) {
              shadowQueries.push({ text: queryText, hidden: false });
            }
          }
        }

        // Extract citations from content_references or search_result_groups
        const citations = this.extractCitations(metadata, message);

        // Get model info
        const model = metadata.model_slug || conversationData.model || 'unknown';

        results.push({
          userPrompt: userPrompt,
          shadowQueries: shadowQueries,
          citations: citations,
          model: model,
          messageId: message.id
        });
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

    // Extract citations from message metadata
    extractCitations(metadata, message) {
      const citations = [];

      // Try content_references (newer format)
      const contentRefs = metadata.content_references || [];
      for (let i = 0; i < contentRefs.length; i++) {
        const ref = contentRefs[i];
        if (ref.url || ref.title) {
          citations.push({
            title: ref.title || ref.url || 'Untitled',
            url: ref.url || '',
            type: ref.type || 'Citation',
            refIndex: i + 1
          });
        }
      }

      // Try search_result_groups (older/alternative format)
      const searchResultGroups = metadata.search_result_groups || [];
      for (const group of searchResultGroups) {
        const entries = group.search_results || group.entries || [];
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          // Avoid duplicates
          const alreadyCited = citations.some((c) => c.url === entry.url);
          if (!alreadyCited && (entry.url || entry.title)) {
            citations.push({
              title: entry.title || entry.url || 'Untitled',
              url: entry.url || '',
              type: 'Search Result',
              refIndex: citations.length + 1
            });
          }
        }
      }

      // Also check message content for footnote-style citations
      const parts = message.content?.parts || [];
      for (const part of parts) {
        if (typeof part === 'object' && part.content_type === 'cite') {
          const alreadyCited = citations.some((c) => c.url === part.url);
          if (!alreadyCited && part.url) {
            citations.push({
              title: part.title || part.url,
              url: part.url,
              type: 'Footnote',
              refIndex: citations.length + 1
            });
          }
        }
      }

      return citations;
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
              totalCitations: 0
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
            extractedAt: Date.now()
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
