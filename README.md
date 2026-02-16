# AI Search Visibility Checker Chrome Extension

A Chrome extension that instantly analyzes whether websites are visible to AI search engines like ChatGPT, Claude, and Perplexity.

## Features

- **Instant Analysis**: Checks AI search visibility without reloading pages
- **Smart Detection**: Identifies JavaScript dependencies and framework usage
- **Visual Score**: Green/yellow/red badge showing visibility status
- **Actionable Recommendations**: Specific fixes to improve AI crawler access

## Installation (Development)

1. Clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select this directory
5. The extension icon will appear in your toolbar

## How It Works

The extension uses static DOM analysis to detect patterns that indicate poor AI search visibility:

- **JavaScript Framework Detection**: Identifies React, Vue, Angular, Svelte apps
- **Content Analysis**: Checks for meaningful initial content vs empty containers
- **Meta Tag Scanning**: Reviews robots directives and crawling restrictions
- **Structure Evaluation**: Looks for loading states and dynamic content patterns

## Scoring System

- **80-100**: Excellent AI search visibility (Green badge ✓)
- **50-79**: Some issues detected (Orange badge !)  
- **0-49**: Poor AI search visibility (Red badge ✗)

## Permissions

- `activeTab`: To analyze the current page's content for AI search visibility
- `scripting`: To inject analysis code into pages

## Technical Architecture

- **Content Script**: Runs DOM analysis at page load for AI search visibility
- **Background Script**: Manages state and coordinates components  
- **Popup UI**: Displays detailed results and recommendations

## Development

The extension is built with vanilla JavaScript and follows Chrome Extension Manifest V3 standards.

No build process required - load directly into Chrome for development.


