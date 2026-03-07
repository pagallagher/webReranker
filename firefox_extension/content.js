// content.js

console.log('[content.js] Script loaded on page:', window.location.href);

// Global flags to prevent infinite loops and track processed elements
let isProcessing = false;
let processedElements = new WeakSet();
let feedbackStylesInjected = false;
let currentSelectors = null;

const RERANK_MODE_REORDER = 'reorder';
const RERANK_MODE_HIDE_LOW = 'hide_low';
const HIDE_KEEP_TOP_RATIO = 0.5; // Keep top 50% in hide mode
let rerankMode = RERANK_MODE_REORDER;

function ensureFeedbackStyles() {
    if (feedbackStylesInjected) return;
    if (document.getElementById('webreranker-feedback-style')) {
        feedbackStylesInjected = true;
        return;
    }

    const style = document.createElement('style');
    style.id = 'webreranker-feedback-style';
    style.textContent = `
        .webreranker-feedback {
            display: flex;
            gap: 8px;
            margin-top: 6px;
            font-size: 14px;
            align-items: center;
            position: relative;
            z-index: 9999;
            visibility: visible;
            opacity: 1;
        }
        .webreranker-feedback button {
            border: 1px solid rgba(0, 0, 0, 0.15);
            background: rgba(255, 255, 255, 0.92);
            cursor: pointer;
            padding: 2px 6px;
            border-radius: 6px;
            opacity: 0.9;
            transition: opacity 0.2s;
            line-height: 1.1;
        }
        .webreranker-feedback button:hover {
            opacity: 1;
        }
        [data-view-name='feed-full-update'] .webreranker-feedback,
        [data-view-name='feed-full-update'] .webreranker-feedback button,
        .feed-shared-update-v2 .webreranker-feedback,
        .feed-shared-update-v2 .webreranker-feedback button {
            visibility: visible !important;
            opacity: 1;
        }
    `;
    document.head.appendChild(style);
    feedbackStylesInjected = true;
}

function storageGet(key) {
    return new Promise((resolve) => {
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.get([key], (items) => resolve(items ? items[key] : undefined));
                return;
            }
        } catch (e) {
            console.warn('[storageGet] chrome.storage unavailable', e);
        }
        try {
            resolve(localStorage.getItem(key));
        } catch (e) {
            resolve(undefined);
        }
    });
}

function storageSet(key, value) {
    return new Promise((resolve) => {
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.set({ [key]: value }, () => resolve());
                return;
            }
        } catch (e) {
            console.warn('[storageSet] chrome.storage unavailable', e);
        }
        try {
            localStorage.setItem(key, value);
        } catch (e) {
            // ignore
        }
        resolve();
    });
}

async function loadRerankMode() {
    const saved = await storageGet('webreranker_mode');
    if (saved === RERANK_MODE_HIDE_LOW || saved === RERANK_MODE_REORDER) {
        rerankMode = saved;
    } else {
        rerankMode = RERANK_MODE_REORDER;
    }
    console.log('[loadRerankMode] Current mode:', rerankMode);
}

async function saveRerankMode(mode) {
    rerankMode = mode;
    await storageSet('webreranker_mode', mode);
}

async function reprocessAllVisibleResults() {
    console.log('[reprocessAllVisibleResults] Reprocessing in mode:', rerankMode);
    processedElements = new WeakSet();
    await processResults(currentSelectors, true);
}

function setupModeChangeListener() {
    try {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'local' || !changes.webreranker_mode) return;
            const nextMode = changes.webreranker_mode.newValue;
            if (nextMode !== RERANK_MODE_REORDER && nextMode !== RERANK_MODE_HIDE_LOW) return;
            if (nextMode === rerankMode) return;
            rerankMode = nextMode;
            reprocessAllVisibleResults().catch((e) => {
                console.warn('[setupModeChangeListener] Failed to reprocess after mode change', e);
            });
        });
    } catch (e) {
        console.warn('[setupModeChangeListener] Failed to attach storage listener', e);
    }
}

function isSearchResultsPage() {
    // Heuristic 1: Count total links
    const links = document.querySelectorAll('a');
    const hasManyLinks = links.length > 50;
    console.log(`[isSearchResultsPage] hasManyLinks (${links.length} > 50): ${hasManyLinks}`);

    // Heuristic 2: Check for lists with many items
    const lists = document.querySelectorAll('ul, ol');
    let hasLargeList = false;
    for (let list of lists) {
        if (list.querySelectorAll('li').length > 5) {
            hasLargeList = true;
            break;
        }
    }
    console.log(`[isSearchResultsPage] hasLargeList: ${hasLargeList}`);

    // Heuristic 3: Look for divs with classes indicating results or items
    const resultDivs = document.querySelectorAll('div[class*="result"], div[class*="search"], div[class*="item"], div[class*="listing"]');
    const hasResultDivs = resultDivs.length > 3;
    console.log(`[isSearchResultsPage] hasResultDivs (${resultDivs.length} > 3): ${hasResultDivs}`);

    // Heuristic 4: Check for repeated similar elements (e.g., multiple h3 or h2)
    const h3Links = document.querySelectorAll('h3');
    const h2Links = document.querySelectorAll('h2');
    const hasManyHeadings = h3Links.length > 5 || h2Links.length > 5;
    console.log(`[isSearchResultsPage] hasManyHeadings (h3:${h3Links.length}, h2:${h2Links.length}): ${hasManyHeadings}`);

    // Heuristic 5: Check for pagination or 'next' links
    const nextLinks = Array.from(links).filter(a => a.textContent.toLowerCase().includes('next'));
    const hasPagination = nextLinks.length > 0 || document.querySelector('nav') !== null;
    console.log(`[isSearchResultsPage] hasPagination (nextLinks:${nextLinks.length}): ${hasPagination}`);

    // Heuristic 6: Check for DuckDuckGo article elements
    const duckDuckGoArticles = document.querySelectorAll('article[data-nrn="result"], article[data-testid="result"]');
    const hasDuckDuckGoResults = duckDuckGoArticles.length > 3;
    console.log(`[isSearchResultsPage] hasDuckDuckGoResults (${duckDuckGoArticles.length} > 3): ${hasDuckDuckGoResults}`);

    // Heuristic 7: Check title or meta description for keywords
    const title = document.title.toLowerCase();
    const hasSearchTitle = ['search', 'results', 'find', 'duckduckgo'].some(keyword => title.includes(keyword));
    console.log(`[isSearchResultsPage] hasSearchTitle: ${hasSearchTitle}, title: "${title}"`);

    const metaDesc = document.querySelector('meta[name="description"]');
    const content = metaDesc ? metaDesc.getAttribute('content').toLowerCase() : '';
    const hasSearchMeta = ['search', 'results'].some(keyword => content.includes(keyword));
    console.log(`[isSearchResultsPage] hasSearchMeta: ${hasSearchMeta}`);

    // Combine heuristics
    const indicators = [hasLargeList, hasResultDivs, hasManyHeadings, hasPagination, hasSearchTitle, hasSearchMeta, hasDuckDuckGoResults];
    const strongIndicators = indicators.filter(Boolean).length;

    const result = strongIndicators >= 2 || (hasLargeList && hasManyLinks) || hasDuckDuckGoResults;
    console.log(`[isSearchResultsPage] strongIndicators: ${strongIndicators}, RESULT: ${result}`);
    return result;
}

/**
 * Recursively extract text content from HTML, attempting to identify title and description
 * @param {string} htmlString - Raw HTML string
 * @param {Element} element - DOM element (for additional context)
 * @returns {Object} - { title, description, firstHeading, firstLinkText, firstUrl, longestText }
 */
function extractTextFromHtml(htmlString, element) {
    const result = {
        title: '',
        description: '',
        firstHeading: '',
        firstLinkText: '',
        firstUrl: '',
        longestText: '',
        allText: []
    };
    
    // Create a temporary container to parse HTML safely
    const temp = document.createElement('div');
    temp.innerHTML = htmlString;
    
    // Find first heading (likely title)
    const headings = temp.querySelectorAll('h1, h2, h3, h4, h5, h6');
    if (headings.length > 0) {
        result.firstHeading = headings[0].textContent.trim();
        result.title = result.firstHeading;
    }
    
    // Find first link and URL
    const links = temp.querySelectorAll('a[href]');
    if (links.length > 0) {
        result.firstLinkText = links[0].textContent.trim();
        result.firstUrl = links[0].href;
        // If no heading found, use link text as title
        if (!result.title) {
            result.title = result.firstLinkText;
        }
    }
    
    // Collect all text nodes, filtering out scripts, styles, and short fragments
    const collectText = (node, depth = 0) => {
        if (depth > 10) return; // Prevent excessive recursion
        
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.trim();
            if (text.length > 10 && !text.match(/^[\s\n\r]*$/)) {
                result.allText.push(text);
            }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            // Skip script, style, svg elements
            if (node.tagName && ['SCRIPT', 'STYLE', 'SVG', 'PATH'].includes(node.tagName.toUpperCase())) {
                return;
            }
            for (let child of node.childNodes) {
                collectText(child, depth + 1);
            }
        }
    };
    
    collectText(temp);
    
    // Find longest text block (likely description)
    if (result.allText.length > 0) {
        result.longestText = result.allText.reduce((a, b) => a.length > b.length ? a : b, '');
        
        // Use longest text as description if it's not the title
        const cleanedLongest = result.longestText.toLowerCase();
        const cleanedTitle = result.title.toLowerCase();
        
        if (cleanedLongest !== cleanedTitle && !cleanedLongest.startsWith(cleanedTitle)) {
            result.description = result.longestText;
        } else if (result.allText.length > 1) {
            // Try second longest
            const sorted = [...result.allText].sort((a, b) => b.length - a.length);
            result.description = sorted[1] || sorted[0];
        }
    }
    
    // Additional heuristic: look for common description patterns in element
    if (element && !result.description) {
        const descriptionCandidates = element.querySelectorAll('p, span.description, div.description, [class*="snippet"], [class*="summary"]');
        for (let candidate of descriptionCandidates) {
            const text = candidate.textContent.trim();
            if (text.length > 20 && text !== result.title) {
                result.description = text;
                break;
            }
        }
    }
    
    console.log('[extractTextFromHtml] Extracted:', {
        titleLength: result.title.length,
        descriptionLength: result.description.length,
        textBlocksFound: result.allText.length
    });
    
    return result;
}

function extractSearchResults() {
    const results = [];

    // Try to find result containers
    let resultContainers = document.querySelectorAll('div[class*="result"], div[class*="item"], div[class*="listing"], div[class*="search-result"]');

    if (resultContainers.length === 0) {
        // Fallback: look for h3 links
        const h3Elements = document.querySelectorAll('h3');
        for (let h3 of h3Elements) {
            const container = h3.closest('div') || h3.parentElement;
            const rawHtml = container ? container.outerHTML : h3.outerHTML;
            const extracted = extractTextFromHtml(rawHtml, container || h3);
            
            if (extracted.title || extracted.description) {
                results.push({ 
                    title: extracted.title,
                    url: extracted.firstUrl,
                    description: extracted.description,
                    rawHtml,
                    element: container || h3
                });
            }
        }
    } else {
        for (let container of resultContainers) {
            const rawHtml = container.outerHTML;
            const extracted = extractTextFromHtml(rawHtml, container);
            
            if (extracted.title || extracted.description) {
                results.push({ 
                    title: extracted.title,
                    url: extracted.firstUrl,
                    description: extracted.description,
                    rawHtml,
                    element: container
                });
            }
        }
    }

    return results;
}

async function reorderResults(results) {
    try {
        console.log('[reorderResults] Sending', results.length, 'results to server for reordering in mode:', rerankMode);
        const response = await fetch('http://127.0.0.1:8000/reorder', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                mode: rerankMode,
                results: results.map(r => ({ title: r.title, url: r.url, description: r.description }))
            })
        });
        if (!response.ok) {
            throw new Error('Failed to reorder: ' + response.status);
        }
        const reordered = await response.json();
        console.log('[reorderResults] Server returned reordered results:', reordered);
        // Map back to original elements
        const mapped = reordered.map(item => {
            return results.find(r => r.title === item.title && r.url === item.url);
        }).filter(Boolean);
        console.log('[reorderResults] Mapped back to', mapped.length, 'original elements');
        return mapped;
    } catch (error) {
        console.error('[reorderResults] Error reordering results:', error);
        console.log('[reorderResults] Returning original results (no reordering)');
        return results; // Return original if error
    }
}

// Load selectors from the bundled extension file only (local-only mode)
async function fetchSelectors() {
    try {
        const url = chrome.runtime.getURL('selectors.json');
        console.log('[fetchSelectors] Fetching bundled selectors.json via', url);
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Failed to fetch bundled selectors.json: ${resp.status}`);

        const data = await resp.json();
        console.log('[fetchSelectors] Got bundled selectors:', data);

        const pageUrlFull = window.location.href || '';
        const hostname = window.location.hostname || '';
        let selectors = data;
        if (typeof data === 'object' && !Array.isArray(data)) {
            if ('google' in data && hostname.includes('google.com')) {
                selectors = data.google;
            } else if ('duckduckgo' in data && hostname.includes('duckduckgo.com')) {
                selectors = data.duckduckgo;
            } else if ('linkedin' in data && hostname.includes('linkedin.com')) {
                selectors = data.linkedin;
            } else if ('google' in data && pageUrlFull.toLowerCase().includes('google')) {
                selectors = data.google;
            } else if ('duckduckgo' in data && pageUrlFull.toLowerCase().includes('duckduckgo')) {
                selectors = data.duckduckgo;
            } else if ('linkedin' in data && pageUrlFull.toLowerCase().includes('linkedin')) {
                selectors = data.linkedin;
            } else if ('google' in data) {
                selectors = data.google;
            } else if ('duckduckgo' in data) {
                selectors = data.duckduckgo;
            } else if ('linkedin' in data) {
                selectors = data.linkedin;
            } else {
                selectors = Object.values(data)[0] || data;
            }
        }

        console.log('[fetchSelectors] Returning selectors from bundled file:', selectors);
        return selectors;
    } catch (e) {
        console.warn('[fetchSelectors] Failed to fetch bundled selectors.json:', e);
        return null;
    }
}

function extractWithSelectors(selectors) {
    const results = [];
    let articles = [];
    if (selectors.primaryArticle) {
        articles = Array.from(document.querySelectorAll(selectors.primaryArticle));
    }
    if (articles.length === 0 && selectors.altArticle) {
        articles = Array.from(document.querySelectorAll(selectors.altArticle));
    }

    console.log(`[extractWithSelectors] Platform: ${selectors.platform}, Found ${articles.length} articles`);
    console.log('[extractWithSelectors] Selectors:', selectors);

    for (let i = 0; i < articles.length; i++) {
        const article = articles[i];
        try {
            // Store raw HTML for reliable extraction
            const rawHtml = article.outerHTML;
            
            // Extract using selectors first
            const titleElem = article.querySelector(selectors.title) || article.querySelector('h1, h2, h3, a');
            let title = titleElem ? titleElem.textContent.trim() : '';
            
            const linkElem = article.querySelector(selectors.link) || article.querySelector('a[href]');
            let url = linkElem ? linkElem.href : '';
            
            // Try snippet selectors
            let snippet = '';
            let usedSelector = null;
            const snippetSelectors = Array.isArray(selectors.snippet) 
                ? selectors.snippet 
                : (selectors.snippet || '').split(',').map(s => s.trim()).filter(Boolean);
            
            for (let sel of snippetSelectors) {
                try {
                    const found = article.querySelector(sel);
                    if (found && found.textContent && found.textContent.trim().length > 0) {
                        snippet = found.textContent.trim();
                        usedSelector = sel;
                        break;
                    }
                } catch (e) {
                    console.warn(`[extractWithSelectors] Invalid snippet selector '${sel}'`, e);
                }
            }
            
            // Fallback to recursive text extraction if selectors fail
            if (!title || !snippet) {
                console.log(`[Article ${i}] Selector-based extraction incomplete, using recursive extraction`);
                const extracted = extractTextFromHtml(rawHtml, article);
                
                if (!title) {
                    title = extracted.title || extracted.firstHeading || extracted.firstLinkText || '';
                }
                if (!snippet) {
                    snippet = extracted.description || extracted.longestText || '';
                    usedSelector = 'recursive';
                }
                if (!url && extracted.firstUrl) {
                    url = extracted.firstUrl;
                }
            }
            
            // Skip if still no meaningful content
            if (!title && !snippet) {
                console.log(`[Article ${i}] Skipping - no extractable content`);
                continue;
            }
            
            // Detect ads
            let isAd = false;
            if (linkElem && selectors.adHrefContains && selectors.adHrefContains.length) {
                const href = linkElem.getAttribute('href') || '';
                for (let pattern of selectors.adHrefContains) {
                    if (href.includes(pattern)) { isAd = true; break; }
                }
            }
            
            console.log(`[Article ${i}] Title: "${title.substring(0, 50)}...", URL: "${url}", Snippet length: ${snippet.length}, Selector: ${usedSelector || 'none'}`);
            
            results.push({ 
                title, 
                url, 
                description: snippet, 
                rawHtml,
                element: article, 
                isAd,
                usedSelector
            });
        } catch (e) {
            console.warn('Error extracting article', e);
            continue;
        }
    }

    return results;
}

// Remove results whose elements are nested inside other result elements.
function dedupeResultsByDom(results) {
    const filtered = results.filter((r, i) => {
        try {
            for (let j = 0; j < results.length; j++) {
                if (i === j) continue;
                const other = results[j].element;
                if (!other || !r.element) continue;
                if (other === r.element) continue;
                if (other.contains && other.contains(r.element)) {
                    // r.element is inside other -> drop r
                    return false;
                }
            }
        } catch (e) {
            // ignore errors and keep the item
            return true;
        }
        return true;
    });
    return filtered;
}

async function sendExtractedResults(results, selectors) {
    try {
        const payload = {
            pageUrl: window.location.href,
            platform: selectors && selectors.platform ? selectors.platform : null,
            results: results.map(r => ({ title: r.title, url: r.url, snippet: r.description, isAd: r.isAd }))
        };

        const resp = await fetch('http://127.0.0.1:8000/submit_results', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!resp.ok) console.warn('submit_results returned', resp.status);
    } catch (e) {
        console.warn('Failed to send extracted results to server', e);
    }
}

function applyReordering(reorderedResults) {
    if (reorderedResults.length === 0) return;
    
    console.log('[applyReordering] Reordering', reorderedResults.length, 'results in place');

    // Create a map of original positions: element -> original DOM position
    const originalPositions = new Map();
    reorderedResults.forEach((result, index) => {
        if (result.element && result.element.parentNode) {
            // Store reference to the next sibling to know where to reinsert
            originalPositions.set(result.element, {
                parent: result.element.parentNode,
                nextSibling: result.element.nextSibling,
                originalIndex: index
            });
        }
    });

    // Temporarily detach all result elements from DOM (preserving their siblings/structure)
    const detachedElements = [];
    reorderedResults.forEach(result => {
        if (result.element && result.element.parentNode) {
            result.element.remove();
            detachedElements.push(result.element);
        }
    });

    // Now reinsert elements in the new order, but at their original positions
    // We'll place reordered[i] at the position where original[i] was
    for (let i = 0; i < reorderedResults.length; i++) {
        const newResult = reorderedResults[i]; // This is the result that should go in position i
        const originalResult = detachedElements[i]; // This was the element originally at position i
        
        if (!newResult.element) continue;
        
        // Find where the original element at position i was located
        const posInfo = originalPositions.get(originalResult);
        if (!posInfo) continue;
        
        try {
            // Insert the new element at the old position
            if (posInfo.nextSibling && posInfo.nextSibling.parentNode) {
                // Insert before the next sibling (original position)
                posInfo.parent.insertBefore(newResult.element, posInfo.nextSibling);
            } else {
                // Next sibling was null or removed, append to parent
                posInfo.parent.appendChild(newResult.element);
            }
            console.log(`[applyReordering] Placed "${newResult.title?.substring(0, 30)}..." at position ${i}`);
        } catch (e) {
            console.warn('[applyReordering] Failed to insert element at position', i, e);
        }
        
        // Ensure feedback buttons exist after reordering (defensive)
        try { addFeedbackButtons(newResult); } catch (e) { console.warn('[applyReordering] addFeedbackButtons failed', e); }
    }
    
    console.log('[applyReordering] Reordering complete');
}

function resetHiddenState(results) {
    results.forEach(result => {
        if (!result || !result.element) return;
        result.element.style.removeProperty('display');
        try {
            if (result.element.dataset) {
                result.element.dataset.webrerankerHiddenByMode = '0';
            }
        } catch (e) {
            // ignore dataset errors
        }
    });
}

function applyHideLowMode(reorderedResults) {
    if (!reorderedResults || reorderedResults.length === 0) return;
    resetHiddenState(reorderedResults);

    const keepCount = Math.max(1, Math.ceil(reorderedResults.length * HIDE_KEEP_TOP_RATIO));
    console.log(`[applyHideLowMode] Keeping top ${keepCount}/${reorderedResults.length}, hiding the rest`);

    reorderedResults.forEach((result, index) => {
        if (!result || !result.element) return;
        const shouldHide = index >= keepCount;
        result.element.style.display = shouldHide ? 'none' : '';
        try {
            if (result.element.dataset) {
                result.element.dataset.webrerankerHiddenByMode = shouldHide ? '1' : '0';
            }
        } catch (e) {
            // ignore dataset errors
        }
    });
}

function addFeedbackButtons(result) {
    console.log('[addFeedbackButtons] Adding buttons for:', result && result.title ? result.title : result.element);
    if (!result || !result.element) return;
    ensureFeedbackStyles();

    if (result.element.dataset && result.element.dataset.webrerankerFeedbackAttached === '1') {
        return;
    }

    // Avoid duplicates if already present (lazy loads / reruns)
    try {
        const existing = result.element.querySelector('.webreranker-feedback');
        if (existing) {
            if (result.element.dataset) result.element.dataset.webrerankerFeedbackAttached = '1';
            return;
        }
    } catch (e) {
        // ignore
    }
    // Mark this element as processed so subsequent runs won't add duplicates
    try {
        if (result.element.classList) result.element.classList.add('webreranker-processed');
        else result.element.setAttribute('data-webreranker-processed', '1');
    } catch (e) {
        // ignore if cannot add class
    }

    // Create feedback container
    const feedbackContainer = document.createElement('div');
    feedbackContainer.className = 'webreranker-feedback';
    feedbackContainer.style.cssText = `
        display: flex;
        gap: 8px;
        margin-top: 4px;
        font-size: 14px;
        align-items: center;
    `;

    // Create thumbs up button
    const thumbsUp = document.createElement('button');
    thumbsUp.innerHTML = '👍';
    thumbsUp.title = 'Good result';
    thumbsUp.style.cssText = `
        border: none;
        background: none;
        cursor: pointer;
        padding: 2px 4px;
        border-radius: 3px;
        opacity: 0.6;
        transition: opacity 0.2s;
    `;
    thumbsUp.onmouseover = () => thumbsUp.style.opacity = '1';
    thumbsUp.onmouseout = () => thumbsUp.style.opacity = '0.6';

    // Create thumbs down button
    const thumbsDown = document.createElement('button');
    thumbsDown.innerHTML = '👎';
    thumbsDown.title = 'Poor result';
    thumbsDown.style.cssText = `
        border: none;
        background: none;
        cursor: pointer;
        padding: 2px 4px;
        border-radius: 3px;
        opacity: 0.6;
        transition: opacity 0.2s;
    `;
    thumbsDown.onmouseover = () => thumbsDown.style.opacity = '1';
    thumbsDown.onmouseout = () => thumbsDown.style.opacity = '0.6';

    // Add click handlers (pass event so visual feedback can use the correct target)
    thumbsUp.onclick = (ev) => logFeedback(result, 'positive', ev);
    thumbsDown.onclick = (ev) => logFeedback(result, 'negative', ev);

    // Add buttons to container
    feedbackContainer.appendChild(thumbsUp);
    feedbackContainer.appendChild(thumbsDown);

    // Add container to result element
    result.element.appendChild(feedbackContainer);
    try {
        if (result.element.dataset) result.element.dataset.webrerankerFeedbackAttached = '1';
    } catch (e) {
        // ignore dataset errors
    }
}

async function logFeedback(result, feedback, event) {
    try {
        const feedbackData = {
            timestamp: new Date().toISOString(),
            pageUrl: window.location.href,
            result: {
                title: result.title,
                url: result.url,
                description: result.description
            },
            feedback: feedback,
            signalType: feedback === 'positive' ? 'thumbs_up' : 'thumbs_down',  // Explicit feedback
            userAgent: navigator.userAgent
        };

        // Try to send feedback via the background script to avoid CORS issues
        try {
            await new Promise((resolve) => {
                try {
                    chrome.runtime.sendMessage({ type: 'submit_feedback', feedback: feedbackData }, (resp) => {
                        if (chrome.runtime.lastError) {
                            console.warn('[content.js] Background sendMessage error', chrome.runtime.lastError);
                            resolve(null);
                        } else {
                            resolve(resp);
                        }
                    });
                } catch (e) {
                    console.warn('[content.js] Error sending feedback to background', e);
                    resolve(null);
                }
            });
        } catch (e) {
            console.warn('[content.js] Background feedback failed, falling back to direct fetch', e);
            try {
                await fetch('http://127.0.0.1:8000/feedback', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(feedbackData)
                });
            } catch (e2) {
                console.error('[content.js] Direct feedback fetch also failed', e2);
            }
        }

        // Visual feedback (use provided event if available)
        let button = null;
        if (event && event.target) {
            button = feedback === 'positive' ? event.target.previousElementSibling || event.target : event.target.nextElementSibling || event.target;
        } else {
            // fallback: try to find buttons inside the element
            const fb = result.element.querySelector('.webreranker-feedback');
            if (fb) {
                button = feedback === 'positive' ? fb.querySelector('button') : fb.querySelectorAll('button')[1] || fb.querySelector('button');
            }
        }
        const originalColor = button.style.color;
        button.style.color = feedback === 'positive' ? '#4CAF50' : '#f44336';
        button.style.opacity = '1';
        setTimeout(() => {
            button.style.color = originalColor;
            button.style.opacity = '0.6';
        }, 1000);

    } catch (error) {
        console.error('Error logging feedback:', error);
    }
}

function addClickTracking(results) {
    // Track which URLs have been clicked
    const clickedUrls = new Set();

    // Store index in each result for reliable implicit feedback tracking
    results.forEach((result, index) => {
        result.index = index;
    });

    results.forEach((result) => {
        // Find the actual link element in the result
        const linkElement = result.element.querySelector('a[href]');
        if (linkElement) {
            // Prevent adding multiple listeners to the same link
            try {
                if (linkElement.dataset && linkElement.dataset.webrerankerListener) return;
                if (linkElement.dataset) linkElement.dataset.webrerankerListener = '1';
            } catch (e) {
                // ignore dataset errors
            }

            linkElement.addEventListener('click', async (event) => {
                // Prevent double-logging
                if (clickedUrls.has(result.url)) return;
                clickedUrls.add(result.url);

                // Log the clicked result as positive
                await logImplicitFeedback(result, 'positive', 'click');

                // Log all results above this one (by array index) as negative (implicit)
                // This is reliable across different page structures (Google, DuckDuckGo, etc.)
                for (let i = 0; i < result.index; i++) {
                    const aboveResult = results[i];
                    if (aboveResult && !clickedUrls.has(aboveResult.url)) {
                        await logImplicitFeedback(aboveResult, 'negative', 'skipped_above_click');
                        clickedUrls.add(aboveResult.url);
                    }
                }
            });
        }
    });
}

async function logImplicitFeedback(result, feedback, signalType) {
    try {
        const feedbackData = {
            timestamp: new Date().toISOString(),
            pageUrl: window.location.href,
            result: {
                title: result.title,
                url: result.url,
                description: result.description
            },
            feedback: feedback,
            signalType: signalType,  // 'click', 'thumbs_up', 'thumbs_down', 'skipped_above_click'
            userAgent: navigator.userAgent
        };

        // Send implicit feedback via background where possible
        try {
            await new Promise((resolve) => {
                try {
                    chrome.runtime.sendMessage({ type: 'submit_feedback', feedback: feedbackData }, (resp) => {
                        if (chrome.runtime.lastError) {
                            console.warn('[content.js] Background sendMessage error', chrome.runtime.lastError);
                            resolve(null);
                        } else {
                            resolve(resp);
                        }
                    });
                } catch (e) {
                    console.warn('[content.js] Error sending implicit feedback to background', e);
                    resolve(null);
                }
            });
        } catch (e) {
            console.warn('[content.js] Background implicit feedback failed, falling back to direct fetch', e);
            try {
                await fetch('http://127.0.0.1:8000/feedback', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(feedbackData)
                });
            } catch (e2) {
                console.error('[content.js] Direct implicit feedback fetch also failed', e2);
            }
        }

    } catch (error) {
        console.error('Error logging implicit feedback:', error);
    }
}

// Debounce helper to prevent excessive processing during rapid content loads
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Process results (extracted from main for reusability)
async function processResults(selectors, includeProcessed = false) {
    if (isProcessing) {
        console.log('[processResults] Already processing, skipping...');
        return;
    }
    
    isProcessing = true;
    console.log('[processResults] Starting result processing');
    
    try {
        let results = [];
        if (selectors) {
            console.log('[processResults] Extracting with selectors');
            results = extractWithSelectors(selectors);
            console.log(`[processResults] Extracted ${results.length} results with selectors`);
            try {
                console.log('[processResults] Extracted results details:', results.map(r => ({ title: r.title, url: r.url, snippetLen: r.description ? r.description.length : 0, usedSelector: r.usedSelector })));
            } catch (e) {
                console.warn('[processResults] Could not stringify extracted results', e);
            }
            sendExtractedResults(results, selectors);
        }

        // Fallback to heuristic extractor if selectors not available or no results
        if (!results || results.length === 0) {
            console.log('[processResults] Using fallback heuristic extraction');
            results = extractSearchResults();
            console.log(`[processResults] Extracted ${results.length} results with heuristics`);
        }

        if (results.length > 0) {
            // Filter out already-processed elements unless explicitly reprocessing all
            if (!includeProcessed) {
                results = results.filter(r => !processedElements.has(r.element));
            }
            
            if (results.length === 0) {
                console.log('[processResults] All results already processed');
                return;
            }
            
            // Deduplicate results by DOM containment to avoid multiple controls per visual item
            const before = results.length;
            results = dedupeResultsByDom(results);
            console.log(`[processResults] Deduped results: ${before} -> ${results.length}`);
            
            // Mark elements as processed and add UI controls
            console.log(`[processResults] Processing ${results.length} new results for feedback and reordering`);
            results.forEach(result => {
                processedElements.add(result.element);
                addFeedbackButtons(result);
            });
            
            addClickTracking(results);

            // Then attempt reordering
            const reordered = await reorderResults(results);
            console.log('[processResults] After reorderResults, got', reordered ? reordered.length : 0, 'results back');
            if (reordered && reordered.length > 0) {
                if (rerankMode === RERANK_MODE_HIDE_LOW) {
                    console.log(`[processResults] Applying hide-low mode for ${reordered.length} results`);
                    applyHideLowMode(reordered);
                } else {
                    console.log(`[processResults] Applying reordering for ${reordered.length} results`);
                    resetHiddenState(reordered);
                    applyReordering(reordered);
                }
            } else {
                console.log('[processResults] No reordered results, skipping applyReordering');
            }
        } else {
            console.log('[processResults] No results found');
        }
    } finally {
        isProcessing = false;
    }
}

// Debounced version to handle rapid mutations
const debouncedProcessResults = debounce(processResults, 500);

// Setup MutationObserver to watch for lazy-loaded content
function setupMutationObserver(selectors) {
    console.log('[setupMutationObserver] Setting up observer for lazy-loaded content');
    
    const observer = new MutationObserver((mutations) => {
        // Check if any new result elements were added
        let hasNewResults = false;
        
        for (const mutation of mutations) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        // Explicit LinkedIn lazy-feed detection
                        if (node.matches && (node.matches("[data-view-name='feed-full-update']") || node.matches('.feed-shared-update-v2'))) {
                            hasNewResults = true;
                            break;
                        }
                        if (node.querySelector && (node.querySelector("[data-view-name='feed-full-update']") || node.querySelector('.feed-shared-update-v2'))) {
                            hasNewResults = true;
                            break;
                        }

                        // Check if this matches our selectors
                        if (selectors) {
                            if (selectors.primaryArticle && node.matches && node.matches(selectors.primaryArticle)) {
                                hasNewResults = true;
                                break;
                            }
                            if (selectors.altArticle && node.matches && node.matches(selectors.altArticle)) {
                                hasNewResults = true;
                                break;
                            }
                            // Also check if added node contains result elements
                            if (node.querySelector) {
                                if (selectors.primaryArticle && node.querySelector(selectors.primaryArticle)) {
                                    hasNewResults = true;
                                    break;
                                }
                                if (selectors.altArticle && node.querySelector(selectors.altArticle)) {
                                    hasNewResults = true;
                                    break;
                                }
                            }
                        } else {
                            // Fallback: check for common result patterns
                            if (node.matches && (node.matches('article') || node.matches('div[class*="result"]') || node.matches('div[class*="item"]'))) {
                                hasNewResults = true;
                                break;
                            }
                        }
                    }
                }
            }
            if (hasNewResults) break;
        }
        
        if (hasNewResults) {
            console.log('[setupMutationObserver] New results detected, processing...');
            debouncedProcessResults(selectors);
        }
    });
    
    // Observe the document body for changes
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
    
    console.log('[setupMutationObserver] Observer active');
    return observer;
}

console.log('[content.js] Defining main function');
async function main() {
    await loadRerankMode();
    setupModeChangeListener();

    // Add visual debug indicator
    const debugDiv = document.createElement('div');
    debugDiv.id = 'webreranker-debug';
    debugDiv.style.cssText = 'position: fixed; top: 10px; right: 10px; background: red; color: white; padding: 10px; z-index: 10000; font-family: monospace; font-size: 12px;';
    debugDiv.textContent = 'WebReranker: Starting...';
    document.body.appendChild(debugDiv);

    console.log('[main] FIRST LINE - function has started');
    try {
        debugDiv.textContent = 'WebReranker: Checking if search results page...';
        console.log('[main] Inside try block');
        if (isSearchResultsPage()) {
            debugDiv.textContent = 'WebReranker: Detected as search results page';
            console.log('[main] Page detected as search results page');
            
            // Try to load selectors from server
            const selectors = await fetchSelectors();
            currentSelectors = selectors;
            
            // Process initial results
            await processResults(selectors);
            
            // Set up observer for lazy-loaded content (e.g., LinkedIn infinite scroll)
            setupMutationObserver(selectors);
            
            debugDiv.textContent = 'WebReranker: Active (watching for new content)';
        } else {
            debugDiv.textContent = 'WebReranker: NOT a search results page';
            console.log('[main] Page not detected as search results page');
        }
    } catch (error) {
        debugDiv.textContent = 'WebReranker: ERROR - ' + error.message;
        console.error('[main] CAUGHT ERROR:', error);
        console.error('[main] Error stack:', error.stack);
    }
}

// Run on page load
console.log('[content.js] About to call main()');
const mainPromise = main();
console.log('[content.js] main() returned:', mainPromise);
mainPromise.then(() => {
    console.log('[content.js] main() COMPLETED SUCCESSFULLY');
}).catch(err => {
    console.error('[content.js] ERROR CAUGHT - Error in main():', err);
    console.error('[content.js] ERROR MESSAGE:', err.message);
    console.error('[content.js] ERROR STACK:', err.stack);
});
