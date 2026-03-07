# WebReranker

A tool for reordering web search results to prioritize informative content over affiliate marketing and promotional material using AI.

## Architecture

WebReranker now uses a **browser-based extraction model** where the Firefox extension handles all result extraction directly from the live DOM, then sends extracted results to the backend for reordering and feedback logging.

## Components

- **Firefox Extension**: Primary component that detects search result pages, extracts results using centralized selectors, and sends data to the server
- **FastAPI Server**: REST API that receives extracted results, reorders them using Ollama AI, and logs user feedback
- **Selectors Configuration**: Centralized `firefox_extension/selectors.json` defines CSS selectors for all supported search engines

## Installation

### Prerequisites

- Python 3.12 or higher
- Ollama installed and running (with `deepseek-r1:latest` model)
- Firefox browser

### Setup

1. Clone or download this repository

2. Install Python dependencies:
   ```bash
   pip install -e .
   ```

3. Ensure Ollama is running:
   ```bash
   ollama serve
   ```
   And pull the model:
   ```bash
   ollama pull deepseek-r1:latest
   ```

## Usage

### Running the Server

Start the FastAPI server that powers the reordering:

```bash
python server.py
```

The server will run on `http://127.0.0.1:8000`

### Firefox Extension

The Firefox extension automatically detects and reorders search results on web pages.

#### Installation

1. Open Firefox and navigate to `about:debugging`
2. Click "This Firefox" in the left sidebar
3. Click "Load Temporary Add-on..."
4. Navigate to the `firefox_extension` directory and select `manifest.json`

#### How It Works

- **Extraction**: The extension runs on every page load and uses centralized selectors from `firefox_extension/selectors.json` to extract search results directly from the DOM
- **Detection**: Heuristics detect if the current page is a search results page
- **Selector Fetching**: The background script attempts to fetch the latest selectors from the local server; falls back to bundled selectors if the server is unavailable
- **Result Submission**: Extracted results (title, URL, snippet, ad flags) are POSTed to `/submit_results` for logging
- **Reordering**: The server reorders results using Ollama AI and returns them to the extension
- **DOM Update**: The extension reorders the DOM elements on the page to reflect the new ranking
- **Feedback**: Thumbs up/down buttons allow explicit user feedback on result quality

#### User Feedback

After reordering, each search result displays thumbs up (👍) and thumbs down (👎) buttons. Clicking these buttons:

- Logs your feedback along with the result details
- Helps improve the AI reordering algorithm over time
- Provides data for analyzing result quality

**Implicit Feedback**: The extension also logs implicit signals:
- **Clicking a result** = positive signal (user found it relevant)
- **Results above a clicked result** = negative signal (user skipped them)

This provides much richer feedback data than explicit ratings alone.

Feedback is stored locally in JSON Lines format in the `feedback_logs/` directory.

### Analyzing Feedback

Use the included analysis script to understand user preferences:

```bash
python analyze_feedback.py
```

This will show statistics including:
- Feedback distribution (positive vs negative)
- Signal type breakdown (explicit thumbs vs implicit clicks/skips)
- Explicit vs implicit feedback ratios
- Top domains receiving positive/negative feedback
- Search engine usage patterns
- Time-based activity patterns

#### Supported Sites

The extension works on any website that displays search results in a structured format. It's particularly effective on:
- Google Search
- Bing Search
- Other search engines with similar result layouts

### API Usage

The server provides several endpoints for the extension and client code:

#### Submit Extracted Results (called by extension)
```bash
curl -X POST "http://127.0.0.1:8000/submit_results" \
  -H "Content-Type: application/json" \
  -d '{
    "pageUrl": "https://www.duckduckgo.com/search?q=example",
    "platform": "duckduckgo",
    "results": [
      {"title": "Example Result", "url": "https://example.com", "snippet": "An example", "isAd": false}
    ]
  }'
```
The extension submits extracted results here; they are logged to `feedback_logs/submitted_results_YYYY-MM-DD.jsonl`.

#### Reorder Results
```bash
curl -X POST "http://127.0.0.1:8000/reorder" \
  -H "Content-Type: application/json" \
  -d '[
    {"title": "Example Result", "url": "https://example.com", "description": "An example"}
  ]'
```

#### Log Feedback
```bash
curl -X POST "http://127.0.0.1:8000/feedback" \
  -H "Content-Type: application/json" \
  -d '{
    "timestamp": "2024-01-01T12:00:00Z",
    "pageUrl": "https://www.google.com/search?q=example",
    "result": {
      "title": "Example Result",
      "url": "https://example.com",
      "description": "An example description"
    },
    "feedback": "positive",
    "signalType": "thumbs_up",
    "userAgent": "Mozilla/5.0..."
  }'
```

Signal types:
- `thumbs_up` / `thumbs_down`: Explicit user feedback
- `click`: User clicked on result (implicit positive)
- `skipped_above_click`: Result above clicked result (implicit negative)

#### Get Feedback Statistics
```bash
curl "http://127.0.0.1:8000/feedback/stats"
```

## Configuration

### Selectors

Centralized CSS selectors for extracting results are defined in `firefox_extension/selectors.json`. The extension loads selectors locally from this bundled file.

#### Adding Support for New Search Engines

To add support for a new search engine:
1. Edit `firefox_extension/selectors.json` and add a platform entry
2. Define the CSS selectors for the search engine's result container, title, link, and snippet
3. Optionally add patterns to detect and flag ad results (e.g., `adHrefContains`)

Example:
```json
{
  "platform": "duckduckgo",
  "primaryArticle": "article[data-nrn='result']",
  "altArticle": "article[data-testid='result']",
  "title": "h2",
  "link": "a[href]",
  "snippet": "[data-result='snippet']",
  "adHrefContains": ["duckduckgo.com/y.js", "/y.js"]
}
```

### Ollama Model

By default, the system uses `deepseek-r1:latest`. You can change this in `web_parser.py` in the `reorder_results_with_ollama` function.

### Server Port

The server runs on port 8000 by default. You can change this in `server.py`.

## Development

### Project Structure

- `server.py`: FastAPI server with endpoints for selector serving, result submission, reordering, and feedback logging
- `analyze_feedback.py`: Script to analyze user feedback logs
- `web_parser.py`: Core reordering and AI logic (Ollama integration)
- `firefox_extension/`: Firefox extension files
  - `manifest.json`: Extension manifest (v2)
  - `content.js`: Content script for page analysis, result extraction, and DOM manipulation
  - `background.js`: Background script that proxies selector requests to avoid CORS issues
  - `selectors.json`: Centralized CSS selectors for all supported search engines
- `feedback_logs/`: Directory containing user feedback and submitted results logs (created automatically)
- `pyproject.toml`: Python project configuration

### Testing

Start the server and load the extension:

```bash
# In one terminal, start the server
python server.py
# Or for development with auto-reload:
python -m uvicorn server:app --reload --host 127.0.0.1 --port 8000

# In Firefox:
# 1. Load the extension (about:debugging > Load Temporary Add-on > firefox_extension/manifest.json)
# 2. Open a search engine (e.g., DuckDuckGo) and observe extraction
# 3. Check feedback_logs/ for submitted_results and feedback logs
```

You can also test the reordering API directly:
```python
from web_parser import reorder_results_with_ollama
results = [
    {"title": "Result 1", "url": "https://example1.com", "description": "First result"},
    {"title": "Result 2", "url": "https://example2.com", "description": "Second result"}
]
reordered = reorder_results_with_ollama(results)
print(reordered)
```

## Troubleshooting

### Extension Not Working

- Ensure the server is running on `http://127.0.0.1:8000`
- Check Firefox console for errors (F12 > Console)
- Verify Ollama is running and the `deepseek-r1:latest` model is available
- Check that the page matches one of the selector patterns (view the page HTML structure)
- Look for background script errors in `about:debugging` > Extension Details > Inspect

### Server Errors

- Check server logs for error messages
- Ensure all Python dependencies are installed (`pip install -e .` or `uv sync`)
- Verify Ollama connection and model availability

### Results Not Being Extracted

- The page may not be recognized as a search results page (check heuristics in `content.js`)
- The CSS selectors in `selectors.json` may not match the current page structure
- Try adding `console.log()` in `content.js` to debug selector matching
- Update `selectors.json` if the search engine changed its HTML structure

### Poor Reordering Results

- The AI model may need fine-tuning for specific types of content
- Check the prompts in `web_parser.py` and adjust if needed
- Consider using a different Ollama model for different results

## License

This project is open source. See individual files for license information.