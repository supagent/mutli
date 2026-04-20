"""Multica API tools for the ADK agent.

Each tool makes an HTTP call to the Multica backend API. The agent decides
when to call these based on its reasoning — no static prompt injection needed.

Tool errors return dicts with an "error" key (ADK crashes on raised exceptions).
"""

import json
import os
from urllib.parse import quote

import httpx
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type


def _api_url() -> str:
    """Resolve the Multica API base URL."""
    return os.environ.get("MULTICA_API_URL", "http://localhost:8080")


def _headers() -> dict:
    """Build request headers with auth and workspace context."""
    headers = {"Content-Type": "application/json"}
    token = os.environ.get("MULTICA_AGENT_TOKEN", "")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    ws_id = os.environ.get("MULTICA_WORKSPACE_ID", "")
    if ws_id:
        headers["X-Workspace-ID"] = ws_id
    return headers


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, max=10),
    retry=retry_if_exception_type((httpx.TimeoutException, httpx.ConnectError)),
)
def _http_call(method: str, url: str, headers: dict, body: dict | None = None) -> httpx.Response:
    """Raw HTTP call with retries on transient failures (timeouts, connection errors)."""
    with httpx.Client(timeout=30) as client:
        if method == "GET":
            return client.get(url, headers=headers)
        elif method == "POST":
            return client.post(url, headers=headers, json=body or {})
        elif method == "PUT":
            return client.put(url, headers=headers, json=body or {})
        else:
            raise ValueError(f"Unsupported method: {method}")


def _request(method: str, path: str, body: dict | None = None) -> dict:
    """Make an HTTP request to the Multica API. Returns response or error dict."""
    url = f"{_api_url()}{path}"
    try:
        resp = _http_call(method, url, _headers(), body)
        if resp.status_code >= 400:
            return {"error": f"API returned {resp.status_code}: {resp.text[:500]}"}
        return resp.json()
    except httpx.TimeoutException:
        return {"error": f"API request timed out after retries: {method} {path}"}
    except httpx.ConnectError:
        return {"error": f"API connection failed after retries: {method} {path}"}
    except Exception as e:
        return {"error": f"API request failed: {e}"}


# ── Issue tools ──────────────────────────────────────────────────────────────


def get_issue(issue_id: str) -> dict:
    """Get full details of an issue including title, description, status, priority, and assignee."""
    return _request("GET", f"/api/issues/{issue_id}")


def search_issues(query: str) -> dict:
    """Search for issues by keyword. Returns matching issues with title, status, and relevance."""
    return _request("GET", f"/api/issues/search?q={quote(query)}")


def update_issue(issue_id: str, status: str) -> dict:
    """Update an issue's status. Valid statuses: backlog, todo, in_progress, done, cancelled."""
    return _request("PUT", f"/api/issues/{issue_id}", {"status": status})


# ── Comment tools ────────────────────────────────────────────────────────────


def list_comments(issue_id: str) -> dict:
    """List all comments on an issue, ordered chronologically."""
    return _request("GET", f"/api/issues/{issue_id}/comments")


def add_comment(issue_id: str, content: str) -> dict:
    """Add a comment to an issue. Use markdown formatting. Be concise and professional."""
    return _request("POST", f"/api/issues/{issue_id}/comments", {"content": content})


# ── Document tools ───────────────────────────────────────────────────────────


def create_document(filename: str, content: str) -> dict:
    """Create a document file in /workspace/output/. Supports .md, .txt formats.

    For .docx or .xlsx files, use create_docx or create_xlsx instead.
    """
    output_dir = "/workspace/output"
    try:
        os.makedirs(output_dir, exist_ok=True)
        filepath = os.path.join(output_dir, filename)
        with open(filepath, "w") as f:
            f.write(content)
        return {"filename": filename, "path": filepath, "status": "created"}
    except Exception as e:
        return {"error": f"Failed to create document: {e}"}


def create_docx(filename: str, content: str) -> dict:
    """Create a Word document (.docx) in /workspace/output/. Content is plain text
    that will be formatted as paragraphs."""
    output_dir = "/workspace/output"
    try:
        os.makedirs(output_dir, exist_ok=True)
        from docx import Document
        doc = Document()
        for para in content.split("\n\n"):
            doc.add_paragraph(para.strip())
        filepath = os.path.join(output_dir, filename)
        doc.save(filepath)
        size = os.path.getsize(filepath)
        return {"filename": filename, "path": filepath, "size_bytes": size, "status": "created"}
    except Exception as e:
        return {"error": f"Failed to create docx: {e}"}


def create_xlsx(filename: str, data_json: str) -> dict:
    """Create an Excel spreadsheet (.xlsx) in /workspace/output/.

    data_json should be a JSON string with format:
    {"headers": ["Col1", "Col2"], "rows": [["val1", "val2"], ...]}
    """
    output_dir = "/workspace/output"
    try:
        os.makedirs(output_dir, exist_ok=True)
        data = json.loads(data_json)
        from openpyxl import Workbook
        wb = Workbook()
        ws = wb.active
        if "headers" in data:
            ws.append(data["headers"])
        for row in data.get("rows", []):
            ws.append(row)
        filepath = os.path.join(output_dir, filename)
        wb.save(filepath)
        size = os.path.getsize(filepath)
        return {"filename": filename, "path": filepath, "size_bytes": size, "status": "created"}
    except Exception as e:
        return {"error": f"Failed to create xlsx: {e}"}


# ── Tool registry ────────────────────────────────────────────────────────────

ALL_TOOLS = [
    get_issue,
    search_issues,
    update_issue,
    list_comments,
    add_comment,
    create_document,
    create_docx,
    create_xlsx,
]
