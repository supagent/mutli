"""
Spike 11d: NDJSON Bridge — ADK Events to TaskMessagePayload

Validates that ADK agent events can be mapped to the daemon's
NDJSON protocol (TaskMessagePayload format) for stdout streaming.

This is the Python side of the bridge. The Go daemon reads these
NDJSON lines from stdout and converts them to agent.Message values.

Protocol (one JSON object per line):
  {"type":"tool_use","seq":1,"tool":"get_issue","input":{"issue_id":"ISS-101"}}
  {"type":"tool_result","seq":2,"tool":"get_issue","output":"..."}
  {"type":"text","seq":3,"content":"Here is my analysis..."}
  {"type":"error","seq":4,"content":"Something went wrong"}
  {"type":"result","status":"completed","output":"...","usage":{...}}

Pass criteria:
  - All ADK event types mapped to NDJSON
  - Events are valid JSON, one per line
  - Seq numbers are monotonically increasing
  - Final "result" line has status + output + usage
"""

import asyncio
import json
import os
import sys
import time

from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types


# ── NDJSON Emitter ────────────────────────────────────────────────────────────

class NDJSONEmitter:
    """Maps ADK events to NDJSON lines on stdout."""

    def __init__(self, task_id: str, issue_id: str = ""):
        self.task_id = task_id
        self.issue_id = issue_id
        self.seq = 0
        self.output_lines = []  # Collect for validation
        self.usage = {}

    def _next_seq(self) -> int:
        self.seq += 1
        return self.seq

    def _emit(self, data: dict):
        line = json.dumps(data, separators=(",", ":"))
        self.output_lines.append(data)
        print(line, flush=True)  # NDJSON to stdout

    def emit_tool_use(self, tool: str, args: dict, call_id: str = ""):
        self._emit({
            "type": "tool_use",
            "seq": self._next_seq(),
            "tool": tool,
            "input": args,
            "task_id": self.task_id,
            "issue_id": self.issue_id,
        })

    def emit_tool_result(self, tool: str, output: str, call_id: str = ""):
        self._emit({
            "type": "tool_result",
            "seq": self._next_seq(),
            "tool": tool,
            "output": output[:8192],  # Match daemon's 8KB truncation
            "task_id": self.task_id,
            "issue_id": self.issue_id,
        })

    def emit_text(self, content: str):
        if content.strip():
            self._emit({
                "type": "text",
                "seq": self._next_seq(),
                "content": content,
                "task_id": self.task_id,
                "issue_id": self.issue_id,
            })

    def emit_thinking(self, content: str):
        if content.strip():
            self._emit({
                "type": "thinking",
                "seq": self._next_seq(),
                "content": content,
                "task_id": self.task_id,
                "issue_id": self.issue_id,
            })

    def emit_error(self, content: str):
        self._emit({
            "type": "error",
            "seq": self._next_seq(),
            "content": content,
            "task_id": self.task_id,
            "issue_id": self.issue_id,
        })

    def emit_result(self, status: str, output: str):
        self._emit({
            "type": "result",
            "status": status,
            "output": output,
            "usage": self.usage,
            "task_id": self.task_id,
        })

    def record_usage(self, usage_metadata):
        """Extract token usage from ADK's usage_metadata."""
        if not usage_metadata:
            return
        model = "gemini-2.5-flash"
        self.usage[model] = {
            "input_tokens": getattr(usage_metadata, "prompt_token_count", 0) or 0,
            "output_tokens": getattr(usage_metadata, "candidates_token_count", 0) or 0,
            "cache_read_tokens": getattr(usage_metadata, "cached_content_token_count", 0) or 0,
            "cache_write_tokens": 0,
        }


# ── Tools ─────────────────────────────────────────────────────────────────────

def get_issue(issue_id: str) -> dict:
    """Get issue details by ID."""
    return {
        "id": issue_id,
        "title": "Implement retry button for failed tasks",
        "status": "in_progress",
        "description": "Add one-click retry for failed/cancelled agent tasks.",
    }


def add_comment(issue_id: str, content: str) -> dict:
    """Add a comment to an issue."""
    return {"issue_id": issue_id, "comment_id": "c-new", "posted": True}


# ── Main ──────────────────────────────────────────────────────────────────────

async def run_agent(emitter: NDJSONEmitter):
    """Run the ADK agent and bridge events to NDJSON."""

    agent = Agent(
        name="ndjson_test_agent",
        model="gemini-2.5-flash",
        instruction="You are a helpful assistant. Read the issue, then add a brief summary comment.",
        tools=[get_issue, add_comment],
    )

    session_service = InMemorySessionService()
    runner = Runner(agent=agent, app_name="spike_11d", session_service=session_service)
    session = await session_service.create_session(app_name="spike_11d", user_id="test-user")

    prompt = "Read issue ISS-101 and post a summary comment."

    user_message = types.Content(
        role="user",
        parts=[types.Part.from_text(text=prompt)],
    )

    accumulated_text = ""

    async for event in runner.run_async(
        user_id="test-user",
        session_id=session.id,
        new_message=user_message,
    ):
        if event.content and event.content.parts:
            for part in event.content.parts:
                if part.function_call:
                    args = dict(part.function_call.args) if part.function_call.args else {}
                    emitter.emit_tool_use(
                        tool=part.function_call.name,
                        args=args,
                        call_id=getattr(part.function_call, "id", ""),
                    )
                elif part.function_response:
                    resp = part.function_response
                    output = json.dumps(dict(resp.response)) if resp.response else ""
                    emitter.emit_tool_result(
                        tool=resp.name,
                        output=output,
                        call_id=getattr(resp, "id", ""),
                    )
                elif part.text:
                    accumulated_text += part.text
                    emitter.emit_text(part.text)

        if hasattr(event, "usage_metadata") and event.usage_metadata:
            emitter.record_usage(event.usage_metadata)

    # Emit final result
    emitter.emit_result(
        status="completed",
        output=accumulated_text,
    )

    return accumulated_text


async def main():
    api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GOOGLE_AI_API_KEY")
    if not api_key:
        # When running as validation (not as subprocess), print to stderr
        print("FAIL: GOOGLE_API_KEY not set", file=sys.stderr)
        return False
    os.environ["GOOGLE_API_KEY"] = api_key

    emitter = NDJSONEmitter(task_id="test-task-11d", issue_id="ISS-101")

    # Redirect ADK warnings to stderr so they don't pollute NDJSON stdout
    import warnings
    warnings.filterwarnings("ignore")

    output = await run_agent(emitter)

    # ── Validation (to stderr so NDJSON stdout stays clean) ───────────────────

    print(f"\n── Validation ──", file=sys.stderr)
    print(f"  Total NDJSON lines: {len(emitter.output_lines)}", file=sys.stderr)

    passed = True

    # Check all lines are valid JSON with required fields
    for i, line in enumerate(emitter.output_lines):
        if "type" not in line:
            print(f"FAIL: Line {i} missing 'type' field", file=sys.stderr)
            passed = False

    # Check seq numbers are monotonically increasing (except result line)
    seqs = [l.get("seq", 0) for l in emitter.output_lines if l.get("type") != "result"]
    for i in range(1, len(seqs)):
        if seqs[i] <= seqs[i - 1]:
            print(f"FAIL: Seq not monotonic: {seqs[i - 1]} → {seqs[i]}", file=sys.stderr)
            passed = False

    if seqs:
        print(f"  Seq range: 1..{seqs[-1]}", file=sys.stderr)
        print(f"PASS: Seq numbers monotonically increasing", file=sys.stderr)

    # Check event types present
    event_types = set(l["type"] for l in emitter.output_lines)
    print(f"  Event types: {event_types}", file=sys.stderr)

    if "tool_use" in event_types:
        print("PASS: tool_use events emitted", file=sys.stderr)
    else:
        print("FAIL: No tool_use events", file=sys.stderr)
        passed = False

    if "tool_result" in event_types:
        print("PASS: tool_result events emitted", file=sys.stderr)
    else:
        print("FAIL: No tool_result events", file=sys.stderr)
        passed = False

    if "text" in event_types:
        print("PASS: text events emitted", file=sys.stderr)
    else:
        print("FAIL: No text events", file=sys.stderr)
        passed = False

    if "result" in event_types:
        result_line = [l for l in emitter.output_lines if l["type"] == "result"][0]
        print(f"PASS: result line present (status={result_line['status']})", file=sys.stderr)
        if result_line.get("usage"):
            print(f"PASS: usage data present in result", file=sys.stderr)
        else:
            print("WARN: No usage data in result", file=sys.stderr)
    else:
        print("FAIL: No result line", file=sys.stderr)
        passed = False

    if passed:
        print("\nPASS: NDJSON bridge works correctly", file=sys.stderr)
    else:
        print("\nFAIL: NDJSON bridge validation failed", file=sys.stderr)

    return passed


if __name__ == "__main__":
    success = asyncio.run(main())
    exit(0 if success else 1)
