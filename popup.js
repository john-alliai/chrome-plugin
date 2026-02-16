// AI Search Visibility Checker - Popup Script
// Handles the popup UI and displays analysis results

class PopupManager {
  constructor() {
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

    this.init();
  }

  async init() {
    // Get current tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    this.currentTabId = tabs[0].id;

    // Setup primary CTA button with ROI data
    this.primaryCtaBtn.addEventListener('click', (e) => this.handlePrimaryCTA(e));

    // Load existing results or wait for analysis
    this.loadResults();
  }

  async loadResults() {
    // Initialize retry counter if not exists
    if (!this.retryCount) {
      this.retryCount = 0;
    }

    // Request analysis results from background script
    const response = await chrome.runtime.sendMessage({
      type: 'GET_ANALYSIS',
      tabId: this.currentTabId
    });

    if (response.results) {
      this.displayResults(response.results);
    } else {
      this.retryCount++;
      
      // If we've been waiting too long, trigger a new analysis
      if (this.retryCount >= 10) { // 5 seconds of waiting
        console.log('No analysis results found, triggering new analysis...');
        await this.triggerNewAnalysis();
        this.retryCount = 0; // Reset counter
      }
      
      // Continue checking for results
      setTimeout(() => this.loadResults(), 500);
    }
  }

  async triggerNewAnalysis() {
    try {
      // Reset the loaded flag and trigger new analysis
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
      // Show error state or fallback
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

    // Display score
    this.scoreEl.textContent = results.score;
    this.updateScoreAppearance(results.score);

    // Display ROI information
    if (results.roi) {
      this.displayROIResults(results.roi);
    }

    // Display issues
    if (results.issues && results.issues.length > 0) {
      this.issuesSectionEl.style.display = 'block';
      this.renderIssues(results.issues);
    }

    // Display recommendations
    if (results.recommendations && results.recommendations.length > 0) {
      this.recsSectionEl.style.display = 'block';
      this.renderRecommendations(results.recommendations);
    }
  }

  updateScoreAppearance(score) {
    // Remove existing classes
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
        <div class="issue-message">${issue.message}</div>
        <div class="issue-impact">${issue.impact}</div>
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
        <div class="rec-action">${rec.action}</div>
        <div class="rec-description">${rec.description}</div>
      `;
      
      this.recsListEl.appendChild(recEl);
    });
  }


  displayROIResults(roi) {
    // Format industry name
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
    
    // Display losses with proper formatting
    this.monthlyLossEl.textContent = `$${Math.round(roi.estimatedMonthlyLoss).toLocaleString()}`;
    this.annualLossEl.textContent = `$${Math.round(roi.estimatedAnnualLoss).toLocaleString()}`;
    
    // Store ROI data for enhanced calculation
    this.currentROI = roi;
  }

  async handlePrimaryCTA(e) {
    e.preventDefault();
    
    // Get current tab URL for tracking
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const currentUrl = tabs[0].url;
    
    // Extract clean domain from URL
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
}

// Initialize popup when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new PopupManager();
});
