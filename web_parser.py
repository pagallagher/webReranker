"""Module for reading and parsing web pages."""

import requests
from bs4 import BeautifulSoup
from typing import Optional, List, Dict
from urllib.parse import urljoin, urlparse
from pathlib import Path
from statistics import mean
import ollama
import yaml
import json
import numpy as np
from sklearn.neural_network import MLPRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


def rerank_results_with_feature_interaction_mlp(
    results: List[Dict[str, str]],
    feedback_log_path: str = "feedback_logs/feedback_2026-03-04.jsonl",
    embedding_model: str = "embeddinggemma:latest",
    max_feedback_samples: int = 2000,
    random_state: int = 42,
) -> List[Dict[str, str]]:
    """
    Rerank candidates using a Feature-Interaction MLP.

    Feature vector per candidate:
    [
      aggregated_positive_embedding,
      aggregated_negative_embedding,
      candidate_embedding,
      candidate_embedding - positive_mean,
      candidate_embedding - negative_mean,
      dot(candidate, positive_mean),
      dot(candidate, negative_mean)
    ]

    For now, positive/negative aggregates are bootstrapped from feedback logs.
    """

    if not results:
        return results

    # -------- Helpers --------
    def _extract_embedding(obj: Dict) -> Optional[np.ndarray]:
        # Handles both:
        #   result["embedding"] = [..]
        #   result["embedding"] = {"embedding": [..], ...}
        emb = obj.get("embedding")
        if isinstance(emb, dict):
            emb = emb.get("embedding")
        if emb is None:
            return None
        try:
            arr = np.asarray(emb, dtype=np.float32)
            return arr if arr.ndim == 1 and arr.size > 0 else None
        except Exception:
            return None

    def _feature_vec(
        candidate: np.ndarray,
        pos_agg: np.ndarray,
        neg_agg: np.ndarray,
        pos_mean: np.ndarray,
        neg_mean: np.ndarray,
    ) -> np.ndarray:
        # Align dimensions defensively
        d = min(candidate.size, pos_agg.size, neg_agg.size, pos_mean.size, neg_mean.size)
        c = candidate[:d]
        pa = pos_agg[:d]
        na = neg_agg[:d]
        pm = pos_mean[:d]
        nm = neg_mean[:d]

        dot_pos = float(np.dot(c, pm))
        dot_neg = float(np.dot(c, nm))

        return np.concatenate(
            [
                pa,
                na,
                c,
                c - pm,
                c - nm,
                np.array([dot_pos, dot_neg], dtype=np.float32),
            ]
        ).astype(np.float32)

    # -------- 1) Load positive/negative embeddings from one feedback log (dummy bootstrap) --------
    pos_embeddings: List[np.ndarray] = []
    neg_embeddings: List[np.ndarray] = []

    log_file = Path(feedback_log_path)
    if log_file.exists():
        with log_file.open("r", encoding="utf-8") as f:
            for i, line in enumerate(f):
                if i >= max_feedback_samples:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except Exception:
                    continue

                label = entry.get("feedback")
                result_obj = entry.get("result", {})
                # In your logs embedding is nested at result.embedding.embedding
                emb = _extract_embedding(result_obj)

                if emb is None and isinstance(result_obj.get("embedding"), dict):
                    emb = _extract_embedding(result_obj["embedding"])

                if emb is None:
                    continue

                if label == "positive":
                    pos_embeddings.append(emb)
                elif label == "negative":
                    neg_embeddings.append(emb)

    # Fallbacks if one class is missing in sample log
    if not pos_embeddings or not neg_embeddings:
        # Minimal fallback: generate candidate embeddings and use neutral split
        candidate_embs = []
        for r in results:
            emb = _extract_embedding(r)
            if emb is None:
                emb = np.asarray(embedResult(r, model=embedding_model)["embedding"], dtype=np.float32)
            if emb.ndim == 1 and emb.size > 0:
                candidate_embs.append(emb)

        if not candidate_embs:
            return results

        half = max(1, len(candidate_embs) // 2)
        pos_embeddings = candidate_embs[:half]
        neg_embeddings = candidate_embs[half:] if len(candidate_embs) > half else candidate_embs[:half]

    # Align dimensions across samples
    min_dim = min(min(e.size for e in pos_embeddings), min(e.size for e in neg_embeddings))
    pos_mat = np.vstack([e[:min_dim] for e in pos_embeddings]).astype(np.float32)
    neg_mat = np.vstack([e[:min_dim] for e in neg_embeddings]).astype(np.float32)

    positive_mean = pos_mat.mean(axis=0)
    negative_mean = neg_mat.mean(axis=0)

    # For this "dummy from log sample" version, use means as aggregated vectors.
    aggregated_positive_embedding = positive_mean
    aggregated_negative_embedding = negative_mean

    # -------- 2) Train a small MLP on feedback-derived labels --------
    X_train = []
    y_train = []

    for e in pos_mat:
        X_train.append(
            _feature_vec(
                e,
                aggregated_positive_embedding,
                aggregated_negative_embedding,
                positive_mean,
                negative_mean,
            )
        )
        y_train.append(1.0)

    for e in neg_mat:
        X_train.append(
            _feature_vec(
                e,
                aggregated_positive_embedding,
                aggregated_negative_embedding,
                positive_mean,
                negative_mean,
            )
        )
        y_train.append(0.0)

    X_train = np.vstack(X_train).astype(np.float32)
    y_train = np.asarray(y_train, dtype=np.float32)

    # If labels are degenerate, skip rerank
    if len(np.unique(y_train)) < 2:
        return results

    model = make_pipeline(
        StandardScaler(with_mean=True, with_std=True),
        MLPRegressor(
            hidden_layer_sizes=(128, 64),
            activation="relu",
            solver="adam",
            alpha=1e-4,
            learning_rate_init=1e-3,
            max_iter=400,
            random_state=random_state,
        ),
    )
    model.fit(X_train, y_train)

    # -------- 3) Score candidates --------
    scored = []
    for r in results:
        emb = _extract_embedding(r)
        if emb is None:
            emb = np.asarray(embedResult(r, model=embedding_model)["embedding"], dtype=np.float32)

        if emb.ndim != 1 or emb.size == 0:
            score = 0.0
        else:
            feat = _feature_vec(
                emb,
                aggregated_positive_embedding,
                aggregated_negative_embedding,
                positive_mean,
                negative_mean,
            )
            score = float(model.predict(feat.reshape(1, -1))[0])

        scored.append((score, r))

    scored.sort(key=lambda x: x[0], reverse=True)

    # Optional: attach score for inspection
    reranked = []
    for score, item in scored:
        out = dict(item)
        out["mlp_score"] = score
        reranked.append(out)

    return reranked


def read_webpage(url: str, timeout: int = 10) -> Optional[str]:
    """
    Read the HTML content of a web page.
    
    Args:
        url: The URL of the web page to read
        timeout: Request timeout in seconds (default: 10)
    
    Returns:
        The HTML content as a string, or None if the request fails
    
    Raises:
        requests.RequestException: If the HTTP request fails
    """
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
        response = requests.get(url, timeout=timeout, headers=headers)
        response.raise_for_status()
        return response.text
    except requests.RequestException as e:
        print(f"Error reading webpage {url}: {e}")
        return None


def parse_webpage(html_content: str) -> BeautifulSoup:
    """
    Parse HTML content into a BeautifulSoup object.
    
    Args:
        html_content: The HTML content as a string
    
    Returns:
        A BeautifulSoup object representing the parsed HTML
    """
    return BeautifulSoup(html_content, 'html.parser')


def read_and_parse_webpage(url: str, timeout: int = 10) -> Optional[BeautifulSoup]:
    """
    Read a web page and return a parsed BeautifulSoup object.
    
    Args:
        url: The URL of the web page to read and parse
        timeout: Request timeout in seconds (default: 10)
    
    Returns:
        A BeautifulSoup object, or None if the request fails
    """
    html_content = read_webpage(url, timeout)
    if html_content:
        return parse_webpage(html_content)
    return None


def extract_text(soup: BeautifulSoup, tag: Optional[str] = None) -> str:
    """
    Extract all text from a parsed webpage.
    
    Args:
        soup: A BeautifulSoup object
        tag: Optional specific tag to extract text from (e.g., 'p', 'div')
    
    Returns:
        The extracted text
    """
    if tag:
        elements = soup.find_all(tag)
        text = ' '.join([elem.get_text() for elem in elements])
    else:
        text = soup.get_text()
    
    # Clean up whitespace
    return ' '.join(text.split())


def extract_links(soup: BeautifulSoup, base_url: Optional[str] = None) -> list[str]:
    """
    Extract all links from a parsed webpage.
    
    Args:
        soup: A BeautifulSoup object
        base_url: Optional base URL to convert relative links to absolute
    
    Returns:
        A list of URLs found in the page
    """
    links = []
    for link in soup.find_all('a', href=True):
        href = link['href']
        if base_url and not urlparse(href).netloc:
            href = urljoin(base_url, href)
        if href:
            links.append(href)
    return links


def extract_by_selector(soup: BeautifulSoup, css_selector: str) -> list:
    """
    Extract elements by CSS selector.
    
    Args:
        soup: A BeautifulSoup object
        css_selector: CSS selector string (e.g., '.classname', '#id', 'div.container')
    
    Returns:
        A list of matching elements
    """
    return soup.select(css_selector)


def load_search_rules(yaml_path: str = 'search_rules.yaml') -> Dict[str, Dict]:
    with open(yaml_path, 'r') as f:
        return yaml.safe_load(f)


def load_config(config_path: str = 'config.yaml') -> Dict:
    """Load configuration from YAML file."""
    try:
        with open(config_path, 'r') as f:
            return yaml.safe_load(f)
    except FileNotFoundError:
        # Return default config if file not found
        return {
            'ollama': {
                'reranker_model': 'deepseek-r1:latest',
                'embedding_model': 'embeddinggemma:latest'
            },
            'reranking': {
                'prompt': 'Score this search result from 0 to 100 for informativeness, prioritizing informative content and true builders over affiliate marketing, promotional content or clear AI generated content. Consider if the content provides valuable information, facts, or insights rather than just selling products or services. \n\n{results}\n\nReturn only a list of integers from 0 to 100 each',
                'default_score': 5
            }
        }


def extract_search_results(soup: BeautifulSoup, selector: str = None) -> List[Dict[str, str]]:
    """
    Extract search results from a search results page.
    
    Args:
        soup: A BeautifulSoup object representing the parsed HTML
        selector: Optional CSS selector for result containers
    
    Returns:
        A list of dictionaries, each containing 'title', 'url', 'description'
    """
    results = []
    
    # Use provided selector or fallback to heuristics
    if selector:
        result_containers = soup.select(selector)
    else:
        result_containers = soup.find_all('div', class_=lambda c: c and any(word in (c if isinstance(c, str) else ' '.join(c)).lower() for word in ['result', 'item', 'listing', 'search-result']))
    
    if not result_containers:
        # Fallback: look for h3 links (common in Google SERP)
        h3_elements = soup.find_all('h3')
        for h3 in h3_elements:
            link = h3.find_parent('a') or h3.find('a')
            if link and link.get('href'):
                title = h3.get_text().strip()
                url = link['href']
                # Find description: next p or span
                desc_elem = h3.find_next(['p', 'span'], class_=lambda c: c and 'desc' in (c if isinstance(c, str) else ' '.join(c)).lower())
                if not desc_elem:
                    desc_elem = h3.find_next('p') or h3.find_next('span')
                description = desc_elem.get_text().strip() if desc_elem else ""
                results.append({'title': title, 'url': url, 'description': description})
    else:
        for container in result_containers:
            title_elem = container.find(['h1', 'h2', 'h3', 'a'])
            title = title_elem.get_text().strip() if title_elem else ""
            link = container.find('a', href=True)
            url = link['href'] if link else ""
            desc_elem = container.find(['p', 'span'], class_=lambda c: c and any(word in (c if isinstance(c, str) else ' '.join(c)).lower() for word in ['desc', 'snippet']))
            if not desc_elem:
                desc_elem = container.find('p') or container.find('span')
            description = desc_elem.get_text().strip() if desc_elem else ""
            if title or url:
                results.append({'title': title, 'url': url, 'description': description})
    
    return results


def reorder_results_with_ollama(
    results: List[Dict[str, str]],
    model: str = None,
    config: Dict = None,
    min_score=4,
    mode: str = "reorder",
) -> List[str]:
    """
    Reorder search results using Ollama to prioritize informative content over affiliate marketing.
    
    Args:
        results: List of search result dictionaries with 'title', 'url', 'description'
        model: Ollama model to use (if None, loads from config)
        config: Configuration dict (if None, loads from config.yaml)
    
    Returns:
        Reordered list of results
    """
    if not results:
        return results

    if mode not in {"reorder", "hide_low"}:
        mode = "reorder"
    print(f"[reorder_results_with_ollama] mode={mode}, results={len(results)}")
    
    # Load config if not provided
    if config is None:
        config = load_config()
    
    # Get model and prompt from config
    if model is None:
        model = config.get('ollama', {}).get('reranker_model', 'deepseek-r1:latest')
    
    prompt_template = config.get('prompt_reranking', {}).get('prompt')
    default_score = config.get('reranking', {}).get('default_score', 5)

    entries_prompt = ""
    for result in results:
        entries_prompt += """Result: {0}\n\n
        """.format(str(result)[1:-1])

    prompt = prompt_template.format(results=entries_prompt)
    try:
        response = ollama.chat(
	 	   model=model,
	       messages=[{'role': 'user', 'content': prompt}]
          )['message']['content']
        score_text = response.strip()
        score = [int(i.strip()) for i in score_text.split(',') if i.strip().isdigit()]  # Assuming the model returns a comma-separated list of scores
        #print(score_text)
        #score = int(score_text) if score_text.isdigit() else default_score
    except Exception as e:
        print(f"Error getting score for result: {e}")
        score = [default_score] * len(results)  # default score for all results

    scored_results = []
    if len(score) < len(results):
        score.extend([0] * (len(results) - len(score)))  # Extend score list with default values if it's shorter than results
    for i in range(len(results)):
        scored_results.append((score[i], results[i]))
    
    if mode == "reorder":
    # Sort by score descending
        scored_results.sort(key=lambda x: x[0], reverse=True)
        return [result for score, result in scored_results]
    elif mode == "hide_low":
        # Filter out results below threshold while preserving original order.
        filtered = [result for score, result in scored_results if score >= min_score]
        if filtered:
            return filtered

        # Guarantee at least one result: fall back to the highest-scored item.
        top_result = max(scored_results, key=lambda x: x[0])[1] if scored_results else None
        return [top_result] if top_result is not None else []


def embedd_results_with_ollama(results: List[Dict[str, str]], model: str = "embeddinggemma:latest") -> List[Dict[str, str]]:
    if not results:
        return results
    
    updated_results = []
    for result in results:
        embedding = embedResult(result, model=model)
        result.update(embedding)
        updated_results.append(result)
    return updated_results

def embedResult(result: Dict[str, str], model: str = "embeddinggemma:latest") -> Dict[str, str]:
    content = str(result)#f"{result['title']} {result['description']}"
    try:
        embedding = ollama.embed(model=model, input=content)['embeddings'][0]
        return {'embedding': embedding, **result}
    except Exception as e:
        print(f"Error getting embedding for result: {e}")
        return {'embedding': [], **result}  # default embedding


def _extract_feedback_embedding(entry: Dict) -> Optional[List[float]]:
    """Extract a numeric embedding vector from a feedback log entry."""
    result = entry.get("result") if isinstance(entry, dict) else None
    if not isinstance(result, dict):
        return None

    embedding_obj = result.get("embedding")
    if isinstance(embedding_obj, dict):
        embedding_obj = embedding_obj.get("embedding")

    if not isinstance(embedding_obj, list):
        return None

    cleaned = []
    for value in embedding_obj:
        try:
            cleaned.append(float(value))
        except (TypeError, ValueError):
            return None

    return cleaned if cleaned else None


def aggregate_feedback_embeddings_to_config(
    feedback_dir: str = "feedback_logs",
    config_path: str = "config.yaml",
    decimals: int = 6,
) -> Dict[str, object]:
    """
    Aggregate positive/negative embeddings from all feedback logs and write means to config.yaml.

    Reads all files matching feedback_*.jsonl under feedback_dir, computes class-wise mean
    embeddings, and stores them under `aggregated_feedback_embeddings` in config.yaml.
    """
    feedback_path = Path(feedback_dir)
    feedback_files = sorted(feedback_path.glob("feedback_*.jsonl")) if feedback_path.exists() else []

    positive_embeddings: List[List[float]] = []
    negative_embeddings: List[List[float]] = []
    malformed_lines = 0

    for file_path in feedback_files:
        try:
            with file_path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue

                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        malformed_lines += 1
                        continue

                    embedding = _extract_feedback_embedding(entry)
                    if embedding is None:
                        continue

                    feedback = entry.get("feedback")
                    if feedback == "positive":
                        positive_embeddings.append(embedding)
                    elif feedback == "negative":
                        negative_embeddings.append(embedding)
        except OSError:
            # Ignore unreadable files and continue processing others.
            continue

    if not positive_embeddings or not negative_embeddings:
        raise ValueError(
            "Need at least one positive and one negative embedding across feedback logs."
        )

    # Align dimensions across all vectors by truncating to the smallest shared length.
    min_dim = min(
        min(len(vec) for vec in positive_embeddings),
        min(len(vec) for vec in negative_embeddings),
    )

    def mean_vector(vectors: List[List[float]], dim: int) -> List[float]:
        return [
            round(mean(vec[i] for vec in vectors), decimals)
            for i in range(dim)
        ]

    positive_mean = mean_vector(positive_embeddings, min_dim)
    negative_mean = mean_vector(negative_embeddings, min_dim)

    config = load_config(config_path)
    config["aggregated_feedback_embeddings"] = {
        "updated_from_feedback_logs": True,
        "source_feedback_dir": feedback_dir,
        "source_file_count": len(feedback_files),
        "malformed_line_count": malformed_lines,
        "positive_count": len(positive_embeddings),
        "negative_count": len(negative_embeddings),
        "embedding_dimension": min_dim,
        "positive_mean": positive_mean,
        "negative_mean": negative_mean,
    }

    with open(config_path, "w", encoding="utf-8") as f:
        yaml.safe_dump(config, f, sort_keys=False, allow_unicode=False)

    return config["aggregated_feedback_embeddings"]

def is_search_results_page(soup: BeautifulSoup, url: str, rules: Dict[str, Dict]) -> Optional[List[Dict[str, str]]]:
    """
    Determine if a web page contains a list of search results by matching URL against YAML rules,
    and if so, return reordered results.
    
    Args:
        soup: A BeautifulSoup object representing the parsed HTML
        url: The URL of the page
        rules: Loaded YAML rules dict
    
    Returns:
        Reordered list of search results as dicts, or None if not a search results page
    """
    parsed_url = urlparse(url)
    domain = parsed_url.netloc
    path = parsed_url.path
    
    for site, config in rules.items():
        if domain == config['domain'] and config['path_pattern'] in path:
            # Extract results using site-specific selector
            results = extract_search_results(soup, selector=config['extract_selector'])
            if results:
                return reorder_results_with_ollama(results)
    return None


def process_webpage(url: str, timeout: int = 10) -> Optional[List[Dict[str, str]]]:
    """
    Process a web page URL to determine if it contains search results and return reordered results.
    
    This is the main entry point that combines all parsing and reordering functionality.
    
    Args:
        url: The URL of the web page to process
        timeout: Request timeout in seconds (default: 10)
    
    Returns:
        A list of reordered search results if it's a search results page, or None
    """
    # Step 1: Read and parse the webpage
    soup = read_and_parse_webpage(url, timeout)
    if not soup:
        return None
    
    # Step 2: Load rules and check if it's a search results page
    rules = load_search_rules()
    return is_search_results_page(soup, url, rules)
