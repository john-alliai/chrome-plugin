// AI Search Visibility Checker - Popup Script
// Handles the popup UI: AI Visibility view and Shadow Query Analyzer view

class PopupManager {
  constructor() {
    // Visibility tab elements
    this.loadingEl = document.getElementById('loading');
    this.resultsEl = document.getElementById('results');
    this.scoreEl = document.getElementById('score');
    this.scoreDescEl = document.getElementById('score-description');
    this.issuesSectionEl = document.getElementById('issues-section');
    this.issuesListEl = document.getElementById('issues-list');
    this.recsSectionEl = document.getElementById('recommendations-section');
    this.recsListEl = document.getElementById('recommendations-list');
    this.primaryCtaBtn = document.getElementById('primary-cta-btn');

    // ROI elements
    this.roiSectionEl = document.getElementById('roi-section');
    this.detectedIndustryEl = document.getElementById('detected-industry');
    this.monthlyLossEl = document.getElementById('monthly-loss');
    this.annualLossEl = document.getElementById('annual-loss');

    // Shadow query elements
    this.sqInitialEl = document.getElementById('sq-initial');
    this.sqLoadingEl = document.getElementById('sq-loading');
    this.sqResultsEl = document.getElementById('sq-results');
    this.sqResultsListEl = document.getElementById('sq-results-list');
    this.sqErrorEl = document.getElementById('sq-error');
    this.sqNotChatGPTEl = document.getElementById('sq-not-chatgpt');
    this.sqAnalyzeBtn = document.getElementById('sq-analyze-btn');
    this.sqCopyAllBtn = document.getElementById('sq-copy-all-btn');
    this.sqExportCsvBtn = document.getElementById('sq-export-csv-btn');
    this.sqTotalQueriesEl = document.getElementById('sq-total-queries');
    this.sqTotalCitationsEl = document.getElementById('sq-total-citations');

    // Tab elements
    this.tabBtns = document.querySelectorAll('.tab-btn');
    this.tabContents = {
      'visibility': document.getElementById('tab-visibility'),
      'shadow-queries': document.getElementById('tab-shadow-queries')
    };

    // State
    this.currentTab = null;
    this.currentTabId = null;
    this.isChatGPT = false;
    this.shadowQueryData = null;

    this.init();
  }

  async init() {
    // Get current tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    this.currentTab = tabs[0];
    this.currentTabId = tabs[0].id;

    // Detect if on ChatGPT
    this.isChatGPT = this.currentTab.url?.includes('chatgpt.com');

    // Setup tab switcher
    this.setupTabSwitcher();

    // Setup button handlers
    this.primaryCtaBtn.addEventListener('click', (e) => this.handlePrimaryCTA(e));
    this.sqAnalyzeBtn.addEventListener('click', () => this.triggerShadowAnalysis());
    this.sqCopyAllBtn.addEventListener('click', () => this.handleCopyAll());
    this.sqExportCsvBtn.addEventListener('click', () => this.handleExportCSV());

    // Show appropriate default tab
    if (this.isChatGPT) {
      this.switchTab('shadow-queries');
      this.initShadowQueryView();
    } else {
      this.switchTab('visibility');
      this.loadResults();
    }
  }

  // --- Tab Switching ---

  setupTabSwitcher() {
    this.tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tabName = btn.dataset.tab;
        this.switchTab(tabName);

        // Lazy-load content for the tab if needed
        if (tabName === 'visibility' && !this.visibilityLoaded) {
          this.loadResults();
        } else if (tabName === 'shadow-queries' && !this.sqViewInitialized) {
          this.initShadowQueryView();
        }
      });
    });
  }

  switchTab(tabName) {
    // Update button states
    this.tabBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Update content visibility
    for (const [name, el] of Object.entries(this.tabContents)) {
      el.classList.toggle('active', name === tabName);
    }
  }

  // --- AI Visibility View (existing logic) ---

  async loadResults() {
    this.visibilityLoaded = true;

    if (!this.retryCount) {
      this.retryCount = 0;
    }

    const response = await chrome.runtime.sendMessage({
      type: 'GET_ANALYSIS',
      tabId: this.currentTabId
    });

    if (response.results) {
      this.displayResults(response.results);
    } else {
      this.retryCount++;

      if (this.retryCount >= 10) {
        await this.triggerNewAnalysis();
        this.retryCount = 0;
      }

      setTimeout(() => this.loadResults(), 500);
    }
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
    } catch (error) {
      console.error('Failed to trigger new analysis:', error);
      this.showErrorState();
    }
  }

  showErrorState() {
    this.loadingEl.style.display = 'none';
    this.resultsEl.innerHTML = `
      <div style="text-align: center; padding: 20px; color: #666;">
        <p>Unable to analyze this page.</p>
        <p style="font-size: 12px;">Try refreshing the page and running the extension again.</p>
      </div>
    `;
    this.resultsEl.style.display = 'block';
  }

  displayResults(results) {
    this.loadingEl.style.display = 'none';
    this.resultsEl.style.display = 'block';

    this.scoreEl.textContent = results.score;
    this.updateScoreAppearance(results.score);

    if (results.roi) {
      this.displayROIResults(results.roi);
    }

    if (results.issues && results.issues.length > 0) {
      this.issuesSectionEl.style.display = 'block';
      this.renderIssues(results.issues);
    }

    if (results.recommendations && results.recommendations.length > 0) {
      this.recsSectionEl.style.display = 'block';
      this.renderRecommendations(results.recommendations);
    }
  }

  updateScoreAppearance(score) {
    this.scoreEl.classList.remove('good', 'warning', 'poor');

    let description = '';
    if (score >= 80) {
      this.scoreEl.classList.add('good');
      description = 'Excellent AI search presence';
    } else if (score >= 50) {
      this.scoreEl.classList.add('warning');
      description = 'Some AI search issues';
    } else {
      this.scoreEl.classList.add('poor');
      description = 'Poor AI search presence';
    }

    this.scoreDescEl.textContent = description;
  }

  renderIssues(issues) {
    this.issuesListEl.innerHTML = '';

    issues.forEach(issue => {
      const issueEl = document.createElement('div');
      issueEl.className = `issue ${issue.severity}`;
      issueEl.innerHTML = `
        <div class="issue-message">${this.escapeHtml(issue.message)}</div>
        <div class="issue-impact">${this.escapeHtml(issue.impact)}</div>
      `;
      this.issuesListEl.appendChild(issueEl);
    });
  }

  renderRecommendations(recommendations) {
    this.recsListEl.innerHTML = '';

    recommendations.forEach(rec => {
      const recEl = document.createElement('div');
      recEl.className = 'recommendation';
      recEl.innerHTML = `
        <div class="rec-action">${this.escapeHtml(rec.action)}</div>
        <div class="rec-description">${this.escapeHtml(rec.description)}</div>
      `;
      this.recsListEl.appendChild(recEl);
    });
  }

  displayROIResults(roi) {
    const industryDisplayNames = {
      'travel': 'Travel & Hospitality',
      'finance': 'Finance & Insurance',
      'health': 'Healthcare & Wellness',
      'ecommerce': 'E-commerce & Retail',
      'saas': 'B2B SaaS',
      'content': 'Content & Publishing',
      'agency': 'Agency & Marketing',
      'local': 'Local Services'
    };

    this.detectedIndustryEl.textContent = industryDisplayNames[roi.industry] || 'General Business';
    this.monthlyLossEl.textContent = `$${Math.round(roi.estimatedMonthlyLoss).toLocaleString()}`;
    this.annualLossEl.textContent = `$${Math.round(roi.estimatedAnnualLoss).toLocaleString()}`;
    this.currentROI = roi;
  }

  async handlePrimaryCTA(e) {
    e.preventDefault();

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const currentUrl = tabs[0].url;

    let domain = 'unknown';
    try {
      const urlObj = new URL(currentUrl);
      domain = urlObj.hostname;
    } catch (error) {
      console.log('Could not parse URL:', currentUrl);
    }

    const params = new URLSearchParams({
      source: 'extension',
      website: domain
    });

    const url = `https://www.alliai.com/ai-search-impact-calculator?${params.toString()}`;
    chrome.tabs.create({ url });
  }

  // --- Shadow Query View ---

  async initShadowQueryView() {
    this.sqViewInitialized = true;

    if (!this.isChatGPT) {
      // Not on ChatGPT — show instruction message
      this.sqInitialEl.style.display = 'none';
      this.sqNotChatGPTEl.style.display = 'block';
      return;
    }

    // Extract current conversation ID from the tab URL
    const convMatch = this.currentTab.url?.match(/\/(?:c|g)\/([a-f0-9-]+)/);
    this.currentConversationId = convMatch ? convMatch[1] : null;

    // Check for cached results from background, but only use them
    // if they match the current conversation
    const response = await chrome.runtime.sendMessage({
      type: 'GET_SHADOW_QUERIES',
      tabId: this.currentTabId
    });

    if (response.results && response.results.conversationId === this.currentConversationId) {
      this.displayShadowQueries(response.results);
    }
    // Otherwise, show the default "Analyze" button state
  }

  async triggerShadowAnalysis() {
    // Show loading state
    this.sqInitialEl.style.display = 'none';
    this.sqErrorEl.style.display = 'none';
    this.sqResultsEl.style.display = 'none';
    this.sqLoadingEl.style.display = 'block';
    this.sqAnalyzeBtn.disabled = true;

    try {
      // Send message to chatgpt-content.js to extract shadow queries
      const response = await chrome.tabs.sendMessage(this.currentTabId, {
        type: 'EXTRACT_SHADOW_QUERIES'
      });

      this.sqLoadingEl.style.display = 'none';

      if (response.success && response.data && response.data.totalShadowQueries > 0) {
        this.displayShadowQueries(response.data);
      } else if (response.success && response.data) {
        // Got data but 0 queries — show debug info to help diagnose
        const debug = response.data.debug;
        let debugText = response.message ||
          "This conversation didn't trigger web searches. Try a query that would require current information.";
        if (debug && debug.messages) {
          const searchMsgs = debug.messages.filter(m =>
            m.hasSearchModelQueries || m.hasSearchQueries ||
            m.hasContentReferences || m.hasSearchResultGroups ||
            m.hasCiteMetadata ||
            (m.role === 'tool') ||
            (m.authorName && m.authorName !== '')
          );
          if (searchMsgs.length > 0) {
            debugText += '\n\nDebug — messages with search-related fields:\n' +
              JSON.stringify(searchMsgs, null, 2);
          } else {
            debugText += `\n\nDebug — ${debug.totalMessages} messages found, none with search metadata.`;
            // Show all message summaries for diagnosis
            const roleSummary = debug.messages.map(m =>
              `${m.role}${m.authorName ? '/' + m.authorName : ''} [${m.contentType}] meta:[${m.metadataKeys.join(',')}]`
            );
            debugText += '\nAll messages:\n' + roleSummary.join('\n');
          }
        }
        this.showSQDebug(debugText);
      } else {
        this.showSQError(response.message || 'Failed to extract shadow queries.');
      }
    } catch (error) {
      this.sqLoadingEl.style.display = 'none';
      this.showSQError('Could not connect to ChatGPT page. Try refreshing the page.');
    }

    this.sqAnalyzeBtn.disabled = false;
  }

  displayShadowQueries(data) {
    this.shadowQueryData = data;

    // Hide other states
    this.sqInitialEl.style.display = 'none';
    this.sqLoadingEl.style.display = 'none';
    this.sqErrorEl.style.display = 'none';
    this.sqNotChatGPTEl.style.display = 'none';

    // Update stats
    this.sqTotalQueriesEl.textContent = data.totalShadowQueries || 0;
    this.sqTotalCitationsEl.textContent = data.totalCitations || 0;

    // Render results
    this.sqResultsListEl.innerHTML = '';

    if (data.results && data.results.length > 0) {
      data.results.forEach(result => {
        const groupEl = this.createPromptGroup(result);
        this.sqResultsListEl.appendChild(groupEl);
      });
    }

    this.sqResultsEl.style.display = 'block';
  }

  createPromptGroup(result) {
    const group = document.createElement('div');
    group.className = 'sq-prompt-group';

    // Prompt header
    const header = document.createElement('div');
    header.className = 'sq-prompt-header';
    header.innerHTML = `
      <div class="sq-prompt-label">User Prompt</div>
      <div class="sq-prompt-text">${this.escapeHtml(result.userPrompt)}</div>
    `;
    group.appendChild(header);

    // Shadow queries list
    if (result.shadowQueries && result.shadowQueries.length > 0) {
      const list = document.createElement('ul');
      list.className = 'sq-queries-list';

      result.shadowQueries.forEach(query => {
        const item = document.createElement('li');
        item.className = 'sq-query-item';

        const badgeClass = query.hidden ? 'hidden' : 'visible';
        const badgeText = query.hidden ? 'Shadow' : 'Visible';

        item.innerHTML = `
          <span class="sq-query-badge ${badgeClass}">${badgeText}</span>
          <span class="sq-query-text">${this.escapeHtml(query.text)}</span>
          <button class="sq-copy-btn" data-query="${this.escapeAttr(query.text)}">Copy</button>
        `;

        // Copy button handler
        const copyBtn = item.querySelector('.sq-copy-btn');
        copyBtn.addEventListener('click', () => this.handleCopySingle(copyBtn));

        list.appendChild(item);
      });

      group.appendChild(list);
    }

    // Citations
    if (result.citations && result.citations.length > 0) {
      const citationsEl = document.createElement('div');
      citationsEl.className = 'sq-citations';
      citationsEl.innerHTML = `<div class="sq-citations-title">Sources Cited (${result.citations.length})</div>`;

      result.citations.forEach(citation => {
        const citEl = document.createElement('div');
        citEl.className = 'sq-citation-item';
        if (citation.url) {
          const a = document.createElement('a');
          a.href = citation.url;
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = `${citation.refIndex}. ${citation.title || citation.url}`;
          citEl.appendChild(a);
        } else {
          citEl.textContent = `${citation.refIndex}. ${citation.title}`;
        }
        citationsEl.appendChild(citEl);
      });

      group.appendChild(citationsEl);
    }

    return group;
  }

  // --- Copy & Export ---

  handleCopySingle(btn) {
    const queryText = btn.dataset.query;
    navigator.clipboard.writeText(queryText).then(() => {
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 1500);
    });
  }

  handleCopyAll() {
    if (!this.shadowQueryData || !this.shadowQueryData.results) return;

    const allQueries = [];
    this.shadowQueryData.results.forEach(result => {
      result.shadowQueries.forEach(q => {
        allQueries.push(q.text);
      });
    });

    const text = allQueries.join('\n');
    navigator.clipboard.writeText(text).then(() => {
      this.sqCopyAllBtn.textContent = 'Copied!';
      this.sqCopyAllBtn.classList.add('copied');
      setTimeout(() => {
        this.sqCopyAllBtn.textContent = 'Copy All Queries';
        this.sqCopyAllBtn.classList.remove('copied');
      }, 1500);
    });
  }

  handleExportCSV() {
    if (!this.shadowQueryData || !this.shadowQueryData.results) return;

    const rows = [
      ['Generated by Alli AI Shadow Query Analyzer — alliai.com'],
      [],
      ['User Prompt', 'Shadow Query', 'Type', 'Source URL', 'Source Title']
    ];

    this.shadowQueryData.results.forEach(result => {
      result.shadowQueries.forEach(q => {
        rows.push([
          result.userPrompt,
          q.text,
          q.hidden ? 'Shadow (Hidden)' : 'Visible',
          '',
          ''
        ]);
      });

      if (result.citations) {
        result.citations.forEach(c => {
          rows.push([
            result.userPrompt,
            '',
            'Citation',
            c.url || '',
            c.title || ''
          ]);
        });
      }
    });

    // Build CSV string
    const csvContent = rows.map(row =>
      row.map(cell => {
        const escaped = String(cell).replace(/"/g, '""');
        return `"${escaped}"`;
      }).join(',')
    ).join('\n');

    // Download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `shadow-queries-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- Helpers ---

  showSQDebug(message) {
    this.sqInitialEl.style.display = 'none';
    this.sqLoadingEl.style.display = 'none';
    this.sqResultsEl.style.display = 'none';
    this.sqNotChatGPTEl.style.display = 'none';
    this.sqErrorEl.style.display = 'block';
    this.sqErrorEl.style.background = '#f0f4ff';
    this.sqErrorEl.style.color = '#333';
    this.sqErrorEl.style.textAlign = 'left';
    this.sqErrorEl.style.whiteSpace = 'pre-wrap';
    this.sqErrorEl.style.fontSize = '11px';
    this.sqErrorEl.style.maxHeight = '400px';
    this.sqErrorEl.style.overflowY = 'auto';
    this.sqErrorEl.textContent = message;
  }

  showSQMessage(message) {
    this.sqInitialEl.style.display = 'none';
    this.sqLoadingEl.style.display = 'none';
    this.sqResultsEl.style.display = 'none';
    this.sqErrorEl.style.display = 'block';
    this.sqErrorEl.textContent = message;
    this.sqErrorEl.style.background = '#f0f4ff';
    this.sqErrorEl.style.color = '#333';
  }

  showSQError(message) {
    this.sqInitialEl.style.display = 'none';
    this.sqLoadingEl.style.display = 'none';
    this.sqResultsEl.style.display = 'none';
    this.sqErrorEl.style.display = 'block';
    this.sqErrorEl.textContent = message;
    this.sqErrorEl.style.background = '#fff3cd';
    this.sqErrorEl.style.color = '#856404';
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  escapeAttr(text) {
    return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

// Initialize popup when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new PopupManager();
});
