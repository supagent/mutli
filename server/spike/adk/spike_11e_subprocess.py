"""
Spike 11e: Daemon Subprocess — ADK Agent as Child Process

Validates that an ADK agent can run as a subprocess spawned by the
Go daemon, communicating via NDJSON on stdout.

This script IS the subprocess. The daemon would spawn it with:
  python3 spike_11e_subprocess.py --task-id <id> --issue-id <id> --prompt "..."

It reads env vars for credentials (GOOGLE_API_KEY, MULTICA_SERVER_URL, etc.)
and emits NDJSON events to stdout.

Pass criteria:
  - Process starts and completes cleanly
  - NDJSON events on stdout match TaskMessagePayload protocol
  - Exit code 0 on success, 1 on failure
  - Total cold start (import + agent init + first LLM call) < 5s
"""

import argparse
import asyncio
import json
import os
import sys
import time
import warnings

# Suppress ADK warnings so they don't pollute stdout
warnings.filterwarnings("ignore")

# Track import time (this is the "cold start" for the subprocess)
import_start = time.time()

from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

import_time = round(time.time() - import_start, 2)


# ── NDJSON Emitter (same as spike_11d) ────────────────────────────────────────

class NDJSONEmitter:
    def __init__(self, task_id: str, issue_id: str = ""):
        self.task_id = task_id
        self.issue_id = issue_id
        self.seq = 0
        self.usage = {}

    def _next_seq(self) -> int:
        self.seq += 1
        return self.seq

    def _emit(self, data: dict):
        line = json.dumps(data, separators=(",", ":"))
        sys.stdout.write(line + "\n")
        sys.stdout.flush()

    def emit_tool_use(self, tool: str, args: dict):
        self._emit({"type": "tool_use", "seq": self._next_seq(), "tool": tool, "input": args, "task_id": self.task_id, "issue_id": self.issue_id})

    def emit_tool_result(self, tool: str, output: str):
        self._emit({"type": "tool_result", "seq": self._next_seq(), "tool": tool, "output": output[:8192], "task_id": self.task_id, "issue_id": self.issue_id})

    def emit_text(self, content: str):
        if content.strip():
            self._emit({"type": "text", "seq": self._next_seq(), "content": content, "task_id": self.task_id, "issue_id": self.issue_id})

    def emit_error(self, content: str):
        self._emit({"type": "error", "seq": self._next_seq(), "content": content, "task_id": self.task_id, "issue_id": self.issue_id})

    def emit_result(self, status: str, output: str):
        self._emit({"type": "result", "status": status, "output": output, "usage": self.usage, "task_id": self.task_id})

    def record_usage(self, usage_metadata):
        if not usage_metadata:
            return
        model = "gemini-2.5-flash"
        self.usage[model] = {
            "input_tokens": getattr(usage_metadata, "prompt_token_count", 0) or 0,
            "output_tokens": getattr(usage_metadata, "candidates_token_count", 0) or 0,
        }


# ── Tools ─────────────────────────────────────────────────────────────────────

def get_issue(issue_id: str) -> dict:
    """Get issue details by ID."""
    return {"id": issue_id, "title": "Test subprocess issue", "status": "in_progress", "description": "Validate subprocess execution."}


def add_comment(issue_id: str, content: str) -> dict:
    """Add a comment to an issue."""
    return {"issue_id": issue_id, "comment_id": "c-new", "posted": True}


# ── Main ──────────────────────────────────────────────────────────────────────

async def run(task_id: str, issue_id: str, prompt: str):
    api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GOOGLE_AI_API_KEY")
    if not api_key:
        print(json.dumps({"type": "error", "seq": 1, "content": "GOOGLE_API_KEY not set", "task_id": task_id}))
        return 1
    os.environ["GOOGLE_API_KEY"] = api_key

    emitter = NDJSONEmitter(task_id=task_id, issue_id=issue_id)

    agent = Agent(
        name="subprocess_agent",
        model="gemini-2.5-flash",
        instruction="You are a helpful assistant. Read the issue and add a brief comment.",
        tools=[get_issue, add_comment],
    )

    session_service = InMemorySessionService()
    runner = Runner(agent=agent, app_name="spike_11e", session_service=session_service)
    session = await session_service.create_session(app_name="spike_11e", user_id="daemon")

    user_message = types.Content(
        role="user",
        parts=[types.Part.from_text(text=prompt)],
    )

    accumulated_text = ""

    try:
        async for event in runner.run_async(
            user_id="daemon",
            session_id=session.id,
            new_message=user_message,
        ):
            if event.content and event.content.parts:
                for part in event.content.parts:
                    if part.function_call:
                        args = dict(part.function_call.args) if part.function_call.args else {}
                        emitter.emit_tool_use(part.function_call.name, args)
                    elif part.function_response:
                        output = json.dumps(dict(part.function_response.response)) if part.function_response.response else ""
                        emitter.emit_tool_result(part.function_response.name, output)
                    elif part.text:
                        accumulated_text += part.text
                        emitter.emit_text(part.text)

            if hasattr(event, "usage_metadata") and event.usage_metadata:
                emitter.record_usage(event.usage_metadata)

        emitter.emit_result("completed", accumulated_text)
        return 0

    except Exception as e:
        emitter.emit_error(str(e))
        emitter.emit_result("failed", str(e))
        return 1


def main():
    parser = argparse.ArgumentParser(description="ADK agent subprocess")
    parser.add_argument("--task-id", default="test-task", help="Task ID")
    parser.add_argument("--issue-id", default="ISS-101", help="Issue ID")
    parser.add_argument("--prompt", default="Read issue ISS-101 and post a summary comment.", help="Agent prompt")
    args = parser.parse_args()

    # Log timing to stderr (not stdout — that's for NDJSON)
    print(f"[subprocess] import_time={import_time}s", file=sys.stderr)

    start = time.time()
    exit_code = asyncio.run(run(args.task_id, args.issue_id, args.prompt))
    total = round(time.time() - start, 2)

    print(f"[subprocess] execution_time={total}s, exit_code={exit_code}", file=sys.stderr)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
