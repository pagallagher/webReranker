# Firefox WebReranker Extension

This Firefox extension automatically reorders search results on web pages to prioritize informative content over affiliate marketing and promotional material.

## Installation

1. Ensure you have the Python server running:
   ```bash
   python server.py
   ```
   This starts a FastAPI server on http://127.0.0.1:8000

2. Make sure Ollama is installed and running with the deepseek-r1 model.

3. Load the extension in Firefox:
   - Open Firefox and go to `about:debugging`
   - Click "This Firefox" on the left
   - Click "Load Temporary Add-on"
   - Select the `manifest.json` file from the `firefox_extension` directory

The extension will now run on all web pages and reorder search results when detected.

## UI Toggle

Click the extension toolbar button to open the popup and choose mode:
- `Reorder results` (default)
- `Hide low-ranked results` (keeps top 50%)

The selected mode is persisted in extension storage and applied immediately on supported pages.
In `Hide low-ranked results` mode, if no result meets the score threshold, the extension keeps the highest-scored result so at least one result remains visible.

## How it works

- On each page load, the extension checks if the page contains search results using heuristics
- If search results are detected, it extracts the result data
- Sends the data to the local Python server for AI-powered reordering
- Reorders the DOM elements on the page according to the new ranking

## Requirements

- Firefox browser
- Python 3.12+
- Ollama with deepseek-r1 model
- Dependencies from pyproject.toml
