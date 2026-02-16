// AI Search Visibility Checker - Content Script with ROI Analysis
// Analyzes DOM patterns and calculates potential revenue impact

// Prevent multiple executions using IIFE
(function() {
  if (window.aiSearchVisibilityCheckerLoaded) {
    return;
  }
  window.aiSearchVisibilityCheckerLoaded = true;

class AISearchVisibilityAnalyzer {
  constructor() {
    this.analysis = {
      score: 0,
      issues: [],
      recommendations: [],
      details: {},
      roi: {
        industry: 'unknown',
        industryMultiplier: 1.0,
        estimatedMonthlyLoss: 0,
        estimatedAnnualLoss: 0,
        canEnhance: true
      }
    };
    
    // Industry multipliers from calculator research
    this.industryMultipliers = {
      'travel': 1.5,      // Travel sees highest AI referrals
      'finance': 1.5,     // Finance also leads
      'health': 1.3,      // Health sees good Perplexity adoption
      'ecommerce': 1.3,   // E-commerce strong on Perplexity
      'saas': 1.2,        // B2B SaaS moderate adoption
      'content': 1.1,     // Content/Publishing moderate
      'agency': 1.0,      // Agency baseline
      'local': 0.8        // Local services lower adoption
    };
    
    // Current AI search market data
    this.currentAIShare = 0.0124; // 1.24% of organic traffic
  }

  // Main analysis entry point
  analyze() {
    this.detectIndustry();
    this.checkInitialDOM();
    this.detectJSFrameworks();
    this.analyzeContentStructure();
    this.checkMetaTags();
    this.checkRobotsDirectives();
    this.calculateTechnicalScore();
    this.estimateROIImpact();
    this.generateRecommendations();
    
    return this.analysis;
  }

  // Auto-detect industry based on page content and patterns
  detectIndustry() {
    const title = document.title.toLowerCase();
    const description = document.querySelector('meta[name="description"]')?.getAttribute('content')?.toLowerCase() || '';
    const bodyText = document.body?.textContent?.toLowerCase() || '';
    const domain = window.location.hostname.toLowerCase();
    
    // Combine all text for analysis
    const allText = `${title} ${description} ${bodyText.substring(0, 2000)}`;
    
    // Industry detection patterns
    const industryPatterns = {
      'travel': ['travel', 'hotel', 'flight', 'booking', 'vacation', 'trip', 'tourism', 'resort', 'airbnb', 'expedia'],
      'finance': ['bank', 'finance', 'loan', 'credit', 'investment', 'insurance', 'trading', 'fintech', 'wallet', 'payment'],
      'health': ['health', 'medical', 'doctor', 'hospital', 'medicine', 'healthcare', 'wellness', 'fitness', 'pharmacy', 'dental'],
      'ecommerce': ['shop', 'store', 'buy', 'cart', 'checkout', 'product', 'price', 'order', 'shipping', 'amazon', 'shopify'],
      'saas': ['software', 'app', 'platform', 'tool', 'service', 'solution', 'dashboard', 'api', 'integration', 'automation'],
      'content': ['blog', 'news', 'article', 'content', 'media', 'publishing', 'magazine', 'journal', 'editorial'],
      'agency': ['agency', 'marketing', 'advertising', 'creative', 'design', 'consulting', 'services', 'digital'],
      'local': ['local', 'restaurant', 'salon', 'repair', 'cleaning', 'plumber', 'dentist', 'lawyer', 'realtor']
    };
    
    let bestMatch = 'agency'; // default
    let maxScore = 0;
    
    for (const [industry, keywords] of Object.entries(industryPatterns)) {
      let score = 0;
      keywords.forEach(keyword => {
        // Higher weight for title and description
        if (title.includes(keyword)) score += 3;
        if (description.includes(keyword)) score += 2;
        if (domain.includes(keyword)) score += 2;
        if (allText.includes(keyword)) score += 1;
      });
      
      if (score > maxScore) {
        maxScore = score;
        bestMatch = industry;
      }
    }
    
    this.analysis.roi.industry = bestMatch;
    this.analysis.roi.industryMultiplier = this.industryMultipliers[bestMatch];
    this.analysis.details.industryDetectionScore = maxScore;
  }

  // Check if initial DOM has meaningful content
  checkInitialDOM() {
    const bodyText = document.body?.textContent?.trim() || '';
    const visibleElements = document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, article, section');
    
    this.analysis.details.initialContentLength = bodyText.length;
    this.analysis.details.visibleElements = visibleElements.length;
    
    // Flag if page is mostly empty (likely JS-dependent)
    if (bodyText.length < 200 && visibleElements.length < 3) {
      this.analysis.issues.push({
        type: 'low_initial_content',
        severity: 'high',
        message: 'Page has very little content without JavaScript',
        impact: 'AI search engines may see an empty or incomplete page',
        roiImpact: 40 // 40% visibility penalty
      });
    }
  }

  // Detect common JS frameworks that indicate heavy JS dependency
  detectJSFrameworks() {
    const frameworks = {
      react: {
        selectors: ['[data-reactroot]', '[data-react-helmet]', '#root[data-reactroot]'],
        scripts: ['react', 'react-dom']
      },
      vue: {
        selectors: ['[data-v-]', '[v-cloak]', '#app[data-v-]'],
        scripts: ['vue', 'vue.js']
      },
      angular: {
        selectors: ['[ng-app]', '[ng-controller]', '[ng-bind]', 'ng-component'],
        scripts: ['angular', '@angular']
      },
      svelte: {
        selectors: ['[data-svelte]'],
        scripts: ['svelte']
      }
    };

    const detectedFrameworks = [];
    
    for (const [name, config] of Object.entries(frameworks)) {
      // Check DOM selectors
      const hasSelectors = config.selectors.some(selector => 
        document.querySelector(selector) !== null
      );
      
      // Check script tags
      const scripts = Array.from(document.querySelectorAll('script')).map(s => s.src || s.textContent);
      const hasScripts = config.scripts.some(script => 
        scripts.some(s => s.includes(script))
      );
      
      if (hasSelectors || hasScripts) {
        detectedFrameworks.push(name);
      }
    }

    this.analysis.details.frameworks = detectedFrameworks;
    
    if (detectedFrameworks.length > 0) {
      this.analysis.issues.push({
        type: 'js_framework_detected',
        severity: 'medium',
        message: `JavaScript framework detected: ${detectedFrameworks.join(', ')}`,
        impact: 'AI search engines may not see dynamically rendered content',
        frameworks: detectedFrameworks,
        roiImpact: 40 // Matches calculator's JS-heavy penalty
      });
    }
  }

  // Analyze content structure patterns
  analyzeContentStructure() {
    // Check for empty containers that likely get populated by JS
    const emptyContainers = document.querySelectorAll('div[id], div[class]');
    let suspiciousEmptyDivs = 0;
    
    emptyContainers.forEach(div => {
      const hasId = div.id && (div.id.includes('root') || div.id.includes('app') || div.id.includes('main'));
      const hasClass = div.className && div.className.includes('container');
      const isEmpty = div.textContent.trim().length === 0;
      
      if ((hasId || hasClass) && isEmpty) {
        suspiciousEmptyDivs++;
      }
    });

    this.analysis.details.suspiciousEmptyDivs = suspiciousEmptyDivs;
    
    if (suspiciousEmptyDivs > 2) {
      this.analysis.issues.push({
        type: 'empty_containers',
        severity: 'medium',
        message: `Found ${suspiciousEmptyDivs} empty containers likely filled by JavaScript`,
        impact: 'AI search engines will see empty sections instead of content',
        roiImpact: 25 // Additional visibility penalty
      });
    }

    // Check for loading indicators - suggests slow load times
    const loadingIndicators = document.querySelectorAll('[class*="loading"], [class*="spinner"], [class*="skeleton"]');
    if (loadingIndicators.length > 0) {
      this.analysis.issues.push({
        type: 'loading_indicators',
        severity: 'medium',
        message: `Found ${loadingIndicators.length} loading indicators`,
        impact: 'AI search engines may see loading states instead of final content',
        roiImpact: 35 // Matches calculator's slow load penalty
      });
    }

    // Check for structured data/schema
    const schemaElements = document.querySelectorAll('script[type="application/ld+json"], [itemscope], [vocab]');
    if (schemaElements.length === 0) {
      this.analysis.issues.push({
        type: 'no_structured_data',
        severity: 'medium',
        message: 'No structured data (schema markup) detected',
        impact: 'AI search engines may have difficulty understanding your content context',
        roiImpact: 40 // Matches calculator's no schema penalty
      });
    }
  }

  // Check meta tags relevant to AI crawlers
  checkMetaTags() {
    const robotsMeta = document.querySelector('meta[name="robots"]');
    const googleBotMeta = document.querySelector('meta[name="googlebot"]');
    
    if (robotsMeta) {
      const content = robotsMeta.getAttribute('content').toLowerCase();
      if (content.includes('noindex') || content.includes('nofollow')) {
        this.analysis.issues.push({
          type: 'robots_meta_restrictive',
          severity: 'high',
          message: `Robots meta tag restricts crawling: ${content}`,
          impact: 'AI search engines may be explicitly blocked from indexing',
          roiImpact: 90 // Almost complete visibility loss
        });
      }
    }

    // Check for AI-specific bot directives (if any sites start using them)
    const aiMeta = document.querySelector('meta[name="ai-crawlers"], meta[name="chatgpt"], meta[name="claude"]');
    if (aiMeta) {
      this.analysis.details.aiSpecificMeta = aiMeta.getAttribute('content');
    }
  }

  // Check for robots directives in HTTP headers (via meta http-equiv)
  checkRobotsDirectives() {
    const httpEquivMetas = document.querySelectorAll('meta[http-equiv]');
    httpEquivMetas.forEach(meta => {
      const httpEquiv = meta.getAttribute('http-equiv').toLowerCase();
      const content = meta.getAttribute('content');
      
      if (httpEquiv === 'x-robots-tag' && content) {
        if (content.toLowerCase().includes('noindex')) {
          this.analysis.issues.push({
            type: 'http_robots_restrictive',
            severity: 'high',
            message: `X-Robots-Tag header restricts indexing: ${content}`,
            impact: 'AI search engines may be blocked by HTTP header directives',
            roiImpact: 90 // Almost complete visibility loss
          });
        }
      }
    });
  }

  // Calculate technical AI search score (0-100)
  calculateTechnicalScore() {
    let score = 100; // Start with perfect score
    
    this.analysis.issues.forEach(issue => {
      switch (issue.severity) {
        case 'high':
          score -= 30;
          break;
        case 'medium':
          score -= 15;
          break;
        case 'low':
          score -= 5;
          break;
      }
    });

    // Bonus points for good practices
    if (this.analysis.details.initialContentLength > 1000) {
      score += 5; // Rich initial content
    }
    
    if (this.analysis.details.visibleElements > 10) {
      score += 5; // Well-structured content
    }

    this.analysis.score = Math.max(0, Math.min(100, score));
  }

  // Estimate ROI impact using similar logic to calculator
  estimateROIImpact() {
    // Calculate visibility percentage from technical issues
    const visibilityScore = this.calculateROIVisibilityScore();
    const visibilityPercentage = visibilityScore / 100;
    
    // Store visibility details
    this.analysis.roi.visibilityScore = visibilityScore;
    this.analysis.roi.visibilityPercentage = visibilityPercentage;
    
    // Estimate traffic - we'll use conservative defaults and note this can be enhanced
    const estimatedMonthlyTraffic = this.estimateTrafficTier();
    const estimatedConversionRate = this.estimateConversionRate();
    const estimatedAOV = this.estimateAOV();
    
    // Calculate estimated monthly revenue loss
    const estimatedMonthlyRevenue = estimatedMonthlyTraffic * (estimatedConversionRate / 100) * estimatedAOV;
    const monthlyLoss = (estimatedMonthlyRevenue * this.currentAIShare * this.analysis.roi.industryMultiplier) * (1 - visibilityPercentage);
    
    this.analysis.roi.estimatedMonthlyTraffic = estimatedMonthlyTraffic;
    this.analysis.roi.estimatedConversionRate = estimatedConversionRate;
    this.analysis.roi.estimatedAOV = estimatedAOV;
    this.analysis.roi.estimatedMonthlyRevenue = estimatedMonthlyRevenue;
    this.analysis.roi.estimatedMonthlyLoss = monthlyLoss;
    this.analysis.roi.estimatedAnnualLoss = monthlyLoss * 12;
  }

  // Calculate visibility score for ROI (matches calculator logic)
  calculateROIVisibilityScore() {
    let score = 100;
    
    this.analysis.issues.forEach(issue => {
      if (issue.roiImpact) {
        score -= issue.roiImpact;
      }
    });
    
    // Minimum visibility of 5%
    return Math.max(5, score);
  }

  // Estimate traffic tier based on site characteristics
  estimateTrafficTier() {
    // Very rough estimation based on site complexity and industry
    const contentLength = this.analysis.details.initialContentLength || 0;
    const hasFramework = this.analysis.details.frameworks?.length > 0;
    const industry = this.analysis.roi.industry;
    
    let baseTraffic = 5000; // Conservative baseline
    
    // Adjust based on content richness
    if (contentLength > 5000) baseTraffic *= 2;
    if (contentLength > 10000) baseTraffic *= 1.5;
    
    // Adjust based on framework (suggests more sophisticated site)
    if (hasFramework) baseTraffic *= 1.5;
    
    // Industry multipliers for typical traffic
    const industryTrafficMultipliers = {
      'ecommerce': 2.0,
      'saas': 1.5,
      'content': 3.0,
      'travel': 1.8,
      'finance': 1.2,
      'health': 1.3,
      'agency': 1.0,
      'local': 0.5
    };
    
    baseTraffic *= (industryTrafficMultipliers[industry] || 1.0);
    
    return Math.round(baseTraffic);
  }

  // Estimate conversion rate based on industry
  estimateConversionRate() {
    const industryConversions = {
      'ecommerce': 2.5,
      'saas': 3.0,
      'content': 0.5,
      'travel': 2.0,
      'finance': 4.0,
      'health': 3.5,
      'agency': 5.0,
      'local': 8.0
    };
    
    return industryConversions[this.analysis.roi.industry] || 2.0;
  }

  // Estimate average order value based on industry
  estimateAOV() {
    const industryAOVs = {
      'ecommerce': 75,
      'saas': 500,
      'content': 20,
      'travel': 300,
      'finance': 1000,
      'health': 200,
      'agency': 2000,
      'local': 100
    };
    
    return industryAOVs[this.analysis.roi.industry] || 150;
  }

  // Generate actionable recommendations
  generateRecommendations() {
    // Technical recommendations
    this.analysis.issues.forEach(issue => {
      switch (issue.type) {
        case 'low_initial_content':
          this.analysis.recommendations.push({
            priority: 'high',
            action: 'Implement Server-Side Rendering (SSR)',
            description: 'Render initial content on the server so AI search engines see meaningful content immediately',
            resources: ['Next.js SSR', 'Nuxt.js', 'SvelteKit'],
            roiImpact: `Could recover up to $${Math.round(this.analysis.roi.estimatedMonthlyLoss * 0.4).toLocaleString()}/month`
          });
          break;
          
        case 'js_framework_detected':
          this.analysis.recommendations.push({
            priority: 'medium',
            action: 'Add SEO-friendly rendering',
            description: `Consider SSR or static generation for your ${issue.frameworks.join('/')} app`,
            resources: ['React SSR', 'Vue SSR', 'Angular Universal'],
            roiImpact: `Could recover up to $${Math.round(this.analysis.roi.estimatedMonthlyLoss * 0.4).toLocaleString()}/month`
          });
          break;
          
        case 'no_structured_data':
          this.analysis.recommendations.push({
            priority: 'medium',
            action: 'Add structured data markup',
            description: 'Implement schema.org markup to help AI search engines understand your content',
            resources: ['Schema.org guide', 'JSON-LD generator'],
            roiImpact: `Could recover up to $${Math.round(this.analysis.roi.estimatedMonthlyLoss * 0.4).toLocaleString()}/month`
          });
          break;
          
        case 'robots_meta_restrictive':
          this.analysis.recommendations.push({
            priority: 'high',
            action: 'Review robots meta tag',
            description: 'Update robots directives to allow AI search engine access',
            resources: ['Robots meta tag guide'],
            roiImpact: `Could recover up to $${Math.round(this.analysis.roi.estimatedMonthlyLoss * 0.9).toLocaleString()}/month`
          });
          break;
      }
    });

    // ROI enhancement recommendation
    if (this.analysis.roi.estimatedMonthlyLoss > 100) {
      this.analysis.recommendations.push({
        priority: 'info',
        action: 'Get precise ROI calculation',
        description: 'Click "Enhanced ROI Analysis" to input your actual traffic and conversion data for more accurate revenue impact estimates',
        resources: ['Traffic analytics', 'Conversion tracking']
      });
    }
  }
}

// Run analysis when DOM is ready
function runAnalysis() {
  const analyzer = new AISearchVisibilityAnalyzer();
  const results = analyzer.analyze();
  
  // Send results to background script
  chrome.runtime.sendMessage({
    type: 'ANALYSIS_COMPLETE',
    data: results,
    url: window.location.href
  });
}

// Run analysis immediately for document_start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', runAnalysis);
} else {
  runAnalysis();
}

})(); // End of IIFE
