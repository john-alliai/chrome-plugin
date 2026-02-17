// AI Search Visibility Checker - Background Service Worker
// Manages analysis state and coordinates between content script and popup

class AnalysisManager {
  constructor() {
    this.analysisResults = new Map(); // Store results by tab ID
    this.shadowQueryResults = new Map(); // Store shadow queries by tab ID
    this.setupMessageHandlers();
  }

  setupMessageHandlers() {
    // Listen for analysis results from content script
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'ANALYSIS_COMPLETE') {
        this.handleAnalysisComplete(message.data, sender.tab.id);
        sendResponse({ success: true });
      } else if (message.type === 'GET_ANALYSIS') {
        const results = this.analysisResults.get(message.tabId);
        sendResponse({ results });
      } else if (message.type === 'SHADOW_QUERIES_COMPLETE') {
        const tabId = sender.tab?.id || message.tabId;
        if (tabId) {
          this.shadowQueryResults.set(tabId, {
            ...message.data,
            timestamp: Date.now()
          });
          this.updateBadge(tabId);
        }
        sendResponse({ success: true });
      } else if (message.type === 'GET_SHADOW_QUERIES') {
        const sqResults = this.shadowQueryResults.get(message.tabId);
        sendResponse({ results: sqResults });
      }
      return true; // Keep message channel open for async response
    });

    // Update badge when analysis completes, and clear stale shadow query cache
    // when a ChatGPT tab navigates to a different conversation
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      // Clear shadow query cache when URL changes on a ChatGPT tab
      if (changeInfo.url && changeInfo.url.includes('chatgpt.com')) {
        const cached = this.shadowQueryResults.get(tabId);
        if (cached) {
          // Extract conversation ID from new URL
          const newConvMatch = changeInfo.url.match(/\/(?:c|g)\/([a-f0-9-]+)/);
          const newConvId = newConvMatch ? newConvMatch[1] : null;
          // If conversation changed (or no longer on a conversation), clear cache
          if (cached.conversationId !== newConvId) {
            this.shadowQueryResults.delete(tabId);
            // Reset badge
            chrome.action.setBadgeText({ text: '', tabId });
          }
        }
      }

      if (changeInfo.status === 'complete' && tab.url) {
        this.updateBadge(tabId);
      }
    });

    // Clear analysis when tab is closed
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.analysisResults.delete(tabId);
      this.shadowQueryResults.delete(tabId);
    });
  }

  handleAnalysisComplete(analysisData, tabId) {
    // Store analysis results
    this.analysisResults.set(tabId, {
      ...analysisData,
      timestamp: Date.now()
    });

    // Update extension badge
    this.updateBadge(tabId);
  }

  updateBadge(tabId) {
    // Check if this tab has shadow query results (ChatGPT tab)
    const sqResults = this.shadowQueryResults.get(tabId);
    if (sqResults) {
      const count = sqResults.totalShadowQueries || 0;
      chrome.action.setBadgeText({
        text: count > 0 ? 'FO' : '',
        tabId: tabId
      });
      chrome.action.setBadgeBackgroundColor({
        color: '#00AA00', // Alli green
        tabId: tabId
      });
      chrome.action.setTitle({
        title: count > 0
          ? `Fan-Out Queries: ${count} found`
          : 'Query Fan-Out Analyzer',
        tabId: tabId
      });
      return;
    }

    const results = this.analysisResults.get(tabId);
    if (!results) return;

    const score = results.score;
    let badgeText = '';
    let badgeColor = '';

    if (score >= 80) {
      badgeText = '✓';
      badgeColor = '#00AA00'; // Green
    } else if (score >= 50) {
      badgeText = '!';
      badgeColor = '#FFA500'; // Orange
    } else {
      badgeText = '✗';
      badgeColor = '#FF0000'; // Red
    }

    chrome.action.setBadgeText({
      text: badgeText,
      tabId: tabId
    });

    chrome.action.setBadgeBackgroundColor({
      color: badgeColor,
      tabId: tabId
    });

    // Update title with score
    chrome.action.setTitle({
      title: `AI Search Visibility Score: ${score}/100`,
      tabId: tabId
    });
  }

  // Trigger manual analysis (called from popup)
  async triggerAnalysis(tabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      });
    } catch (error) {
      console.error('Failed to inject content script:', error);
    }
  }
}

// Initialize the analysis manager
const analysisManager = new AnalysisManager();

// Export for popup access
globalThis.analysisManager = analysisManager;


