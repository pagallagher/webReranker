from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional, List, Dict, Any, Union
from web_parser import (
    process_webpage,
    reorder_results_with_ollama,
    embedResult,
    aggregate_feedback_embeddings_to_config,
)
import json
import os
from datetime import datetime

app = FastAPI(title="WebReranker API", description="API for reordering search results")

# Allow requests from content scripts / pages (extension will fetch selectors and submit results)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Create feedback log directory if it doesn't exist
FEEDBACK_LOG_DIR = "feedback_logs"
os.makedirs(FEEDBACK_LOG_DIR, exist_ok=True)

@app.get("/process")
async def process_url(url: str) -> Optional[List[Dict[str, str]]]:
    """
    Process a web page URL to reorder search results if applicable.

    Args:
        url: The URL of the web page to process

    Returns:
        Reordered search results or None
    """
    try:
        result = process_webpage(url)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/reorder")
async def reorder_results(payload: Union[List[Dict[str, str]], Dict[str, Any]]) -> List[Dict[str, str]]:
    """
    Reorder search results using AI.

    Args:
        payload: Either a raw list of search result dictionaries (legacy)
                 or an object with:
                 - results: list of search result dictionaries
                 - mode: 'reorder' or 'hide_low'

    Returns:
        Reordered results
    """
    try:
        mode = "reorder"
        results: List[Dict[str, str]] = []

        if isinstance(payload, list):
            # Backward-compatible input shape
            results = payload
        elif isinstance(payload, dict):
            mode_value = payload.get("mode", "reorder")
            mode = mode_value if mode_value in {"reorder", "hide_low"} else "reorder"
            maybe_results = payload.get("results", [])
            if isinstance(maybe_results, list):
                results = maybe_results

        reordered = reorder_results_with_ollama(results, mode=mode)
        return reordered
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/feedback")
async def log_feedback(feedback_data: Dict):
    """
    Log user feedback on search results.

    Args:
        feedback_data: Dictionary containing feedback information
    """
    try:
        if "embedding" not in feedback_data["result"]:
            feedback_data['result']["embedding"] = embedResult(feedback_data['result'])  # default embedding if not provided
        # Generate filename based on date
        date_str = datetime.now().strftime("%Y-%m-%d")
        filename = f"{FEEDBACK_LOG_DIR}/feedback_{date_str}.jsonl"

        # Append feedback to log file
        with open(filename, 'a', encoding='utf-8') as f:
            f.write(json.dumps(feedback_data, ensure_ascii=False) + '\n')

        return {"status": "success", "message": "Feedback logged successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error logging feedback: {str(e)}")


@app.post("/submit_results")
async def submit_results(payload: Dict):
    """
    Receive structured extraction results from the browser extension.
    Logs them to `feedback_logs/submitted_results_YYYY-MM-DD.jsonl` for inspection.
    """
    try:
        date_str = datetime.now().strftime("%Y-%m-%d")
        filename = f"{FEEDBACK_LOG_DIR}/submitted_results_{date_str}.jsonl"
        # Normalize payload
        entry = {
            "received_at": datetime.now().isoformat(),
            "pageUrl": payload.get("pageUrl"),
            "platform": payload.get("platform"),
            "results": payload.get("results", [])
        }
        with open(filename, 'a', encoding='utf-8') as f:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')
        return {"status": "success", "saved_to": filename}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/feedback/stats")
async def get_feedback_stats():
    """
    Get basic statistics about logged feedback.
    """
    try:
        stats = {"total_feedback": 0, "positive": 0, "negative": 0, "files": []}

        if os.path.exists(FEEDBACK_LOG_DIR):
            for filename in os.listdir(FEEDBACK_LOG_DIR):
                if filename.startswith("feedback_") and filename.endswith(".jsonl"):
                    file_stats = {"filename": filename, "entries": 0, "positive": 0, "negative": 0}
                    filepath = os.path.join(FEEDBACK_LOG_DIR, filename)

                    with open(filepath, 'r', encoding='utf-8') as f:
                        for line in f:
                            if line.strip():
                                entry = json.loads(line)
                                file_stats["entries"] += 1
                                if entry.get("feedback") == "positive":
                                    file_stats["positive"] += 1
                                    stats["positive"] += 1
                                elif entry.get("feedback") == "negative":
                                    file_stats["negative"] += 1
                                    stats["negative"] += 1

                    stats["total_feedback"] += file_stats["entries"]
                    stats["files"].append(file_stats)

        return stats
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error getting stats: {str(e)}")


@app.post("/embeddings/refresh")
async def refresh_aggregated_embeddings(
    feedbackDir: str = FEEDBACK_LOG_DIR,
    configPath: str = "config.yaml",
):
    """
    Recompute aggregated positive/negative embeddings from feedback logs and persist to config.
    """
    try:
        summary = aggregate_feedback_embeddings_to_config(
            feedback_dir=feedbackDir,
            config_path=configPath,
        )
        return {
            "status": "success",
            "message": "Aggregated embeddings refreshed",
            "aggregated": summary,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error refreshing embeddings: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
