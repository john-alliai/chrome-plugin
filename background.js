// AI Search Visibility Checker - Background Service Worker
// Manages analysis state and coordinates between content script and popup

class AnalysisManager {
  constructor() {
    this.analysisResults = new Map(); // Store results by tab ID
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
      }
      return true; // Keep message channel open for async response
    });

    // Update badge when analysis completes
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete' && tab.url) {
        this.updateBadge(tabId);
      }
    });

    // Clear analysis when tab is closed
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.analysisResults.delete(tabId);
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


