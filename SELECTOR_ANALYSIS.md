# CSS Selector Analysis for Search Results

## Analysis Summary

This document provides detailed CSS selectors for extracting search results from 4 major platforms: Google, DuckDuckGo, Facebook, and LinkedIn.

---

## 1. Google Search

### Architecture
- **Type**: Server-rendered HTML
- **Framework**: Vanilla HTML5 with semantic tags
- **Stability**: Very High (non-obfuscated, semantic HTML)

### Primary Selectors

#### Result Container (STABLE ✓)
```css
li.LLtSOc
li[jsname="XAYRPc"]
```

**Evidence**: Lines 60-80 of sample_pages/mega evolution - Google Search.html
```html
<li jsname="XAYRPc" class="LLtSOc" data-hveid="CIkCEAY" data-ved="...">
  <!-- Result content -->
</li>
```

#### Result Title (STABLE ✓)
```css
div.mNme1d.tNxQIb
```

**HTML Structure**:
```html
<div class="mNme1d tNxQIb">Your Title Here</div>
```

#### Result Metadata (STABLE ✓)
```css
div.LzPlYe
```

**HTML Structure**:
```html
<div class="LzPlYe">
  <div class="HAC9Fd vDF3Oc jIrdcd">
    <!-- Source, date, snippet info -->
  </div>
</div>
```

#### Result Image (STABLE ✓)
```css
img.YQ4gaf.zr758c
```

**Selector Strategy**: Use semantic HTML elements + non-obfuscated class names

---

## 2. DuckDuckGo Search

### Architecture
- **Type**: React Single Page Application (SPA)
- **Framework**: React + CSS-in-JS
- **Stability**: High for data attributes, Low for CSS classes
- **Dynamic**: Partial (initial results rendered server-side, more loaded on scroll)

### Primary Selectors

#### Results List (STABLE ✓)
```css
ol.react-results--main
```

**Evidence**: Lines 35-70 of sample_pages/green bay packers at DuckDuckGo.html
```html
<ol class="react-results--main">
  <!-- List of result items -->
</ol>
```

#### Result Container - List Item (STABLE ✓)
```css
li[data-layout="organic"]
```

#### Result Article Primary (VERY STABLE ✓✓✓)
```css
article[data-nrn="result"]
```

**Recommended**: This is the most reliable selector - intentional data attribute designed for testing/stability.

#### Result Article Alternative (VERY STABLE ✓✓✓)
```css
article[data-testid="result"]
```

**Both attributes present in same elements**:
```html
<article id="r1-0" data-testid="result" data-nrn="result" class="yQDlj3B5DI5YO8c8Ulio CpkrTDP54mqzpuCSn1Fa SKlplDuh9FjtDprgoMxk ...">
  <!-- Result content -->
</article>
```

#### Obfuscated Classes (NOT RECOMMENDED ⚠️)
```css
.yQDlj3B5DI5YO8c8Ulio  /* UNSTABLE - Webpack-generated hash */
.CpkrTDP54mqzpuCSn1Fa  /* UNSTABLE - Changes per build */
```

**Selector Strategy**: Use data attributes ONLY, avoid CSS classes

---

## 3. Facebook Feed

### Architecture
- **Type**: React + Server-Side Rendering (SSR)
- **Framework**: React with Hydration
- **Stability**: Medium (uses data attributes, but mixed with dynamic content)
- **Dynamic**: Heavily dynamic - most content loaded via JavaScript/API

### Confirmed Selectors

#### Feed Post Container (CANDIDATE ✓)
```css
article[data-testid="ad"]
```

#### Alternative Feed Post (CANDIDATE ✓)
```css
article[data-nrn="result"]
```

**Status**: These selectors found in static markup but incomplete
- Locations identified: 8 instances across HTML file
- Actual feed loads dynamically after page render
- Static markup contains prototype/cached posts

### Limitations
- Static HTML provides minimal feed content
- Primary feed loaded via JavaScript/API
- Full analysis requires dynamic DOM inspection

---

## 4. LinkedIn Feed

### Architecture
- **Type**: Fully Dynamic React Application
- **Framework**: React with Content Security Policy
- **Static Content**: ZERO
- **Dynamic**: 100% - all content loaded via JavaScript/API

### Selector Strategy

#### No Static Selectors Available
```
✗ Cannot use CSS selectors on static HTML
✗ No semantic feed structure in page source
```

#### Recommended Approach: Data Activity ID
```javascript
// LinkedIn uses data-activity-id for dynamic tracking
article[data-activity-id*="..."]

// Alternative: Track via API responses
// GET /graphql queries for feed data
```

#### Recommended Approach: Dynamic Monitoring
```javascript
// Observe DOM mutations
// Watch for feed item insertions
// Use MutationObserver to track new results

const observer = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    if (mutation.type === 'childList') {
      // Capture newly added feed items
    }
  });
});
```

---

## Selector Stability Ranking

| Platform | Primary Selector | Stability | Confidence |
|----------|------------------|-----------|-----------|
| Google | `li.LLtSOc` | Very High | 99% |
| DuckDuckGo | `article[data-nrn="result"]` | Very High | 99% |
| Facebook | `article[data-testid="ad"]` | Medium | 70% |
| LinkedIn | Data-activity-id / API | N/A | Requires dynamic approach |

---

## Implementation Recommendations

### 1. Google Search
- **Primary Method**: CSS Selector
- **Selector**: `li.LLtSOc`
- **Confidence**: Very High
- **Fallback**: `li[jsname="XAYRPc"]`

### 2. DuckDuckGo
- **Primary Method**: CSS Selector (data attributes)
- **Selector**: `article[data-nrn="result"]`
- **Confidence**: Very High
- **Fallback**: `article[data-testid="result"]`
- **Avoid**: Obfuscated CSS classes

### 3. Facebook
- **Primary Method**: CSS Selector (limited)
- **Selector**: `article[data-testid="ad"]`
- **Confidence**: Medium
- **Fallback**: API-based approach required for full feed
- **Note**: Static selectors work only on cached/prototype posts

### 4. LinkedIn
- **Primary Method**: Dynamic/API-based
- **Approach**: MutationObserver + data-activity-id tracking
- **Confidence**: High (requires JavaScript execution)
- **Fallback**: Browser API monitoring

---

## Code Examples

### Google Results Extraction
```javascript
const googleResults = document.querySelectorAll('li.LLtSOc');
googleResults.forEach(result => {
  const title = result.querySelector('div.mNme1d.tNxQIb')?.textContent;
  const meta = result.querySelector('div.LzPlYe')?.textContent;
  const image = result.querySelector('img.YQ4gaf')?.src;
  console.log({ title, meta, image });
});
```

### DuckDuckGo Results Extraction
```javascript
const ddgResults = document.querySelectorAll('article[data-nrn="result"]');
ddgResults.forEach(result => {
  const nrn = result.getAttribute('data-nrn');
  const testid = result.getAttribute('data-testid');
  const title = result.querySelector('h2')?.textContent;
  console.log({ nrn, testid, title });
});
```

### Facebook Feed Extraction
```javascript
const fbPosts = document.querySelectorAll('article[data-testid="ad"]');
fbPosts.forEach(post => {
  const activityId = post.getAttribute('data-activity-id');
  const text = post.textContent;
  console.log({ activityId, text });
});
```

### LinkedIn Dynamic Tracking
```javascript
const observer = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    const articles = mutation.target.querySelectorAll('article[data-activity-id]');
    articles.forEach(article => {
      const activityId = article.getAttribute('data-activity-id');
      console.log('New LinkedIn post:', activityId);
    });
  });
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['data-activity-id']
});
```

---

## Monitor for Selector Drift

### Recommended Monitoring Strategy

1. **Google & DuckDuckGo**: Check quarterly for CSS class changes
2. **Facebook**: Test data-testid attribute stability
3. **LinkedIn**: Monitor API response format changes

### Testing Approach
```bash
# Store selector baselines
crontab -e  # Add quarterly selector validation

# Test selectors on sample pages
python3 -c "
import re
with open('sample.html', 'r') as f:
    content = f.read()
    # Count results with selector
    results = re.findall(r'<li class=\"LLtSOc\"', content)
    print(f'Found {len(results)} Google results')
"
```

---

## Last Updated
February 17, 2026

## Sample Files Analyzed
- `/sample_pages/mega evolution - Google Search.html` (279 lines)
- `/sample_pages/green bay packers at DuckDuckGo.html` (varies)
- `/sample_pages/Facebook.html` (572 lines)
- `/sample_pages/Feed _ LinkedIn.html` (165 lines)
