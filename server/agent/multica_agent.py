"""Multica ADK Agent — production entrypoint for embedded agent execution.

Spawned by the Go daemon inside a Daytona sandbox:
  python3 multica_agent.py --task-id <id> --issue-id <id> --prompt "..."

Communicates with the daemon via NDJSON on stdout. All logs go to stderr.
Exit code 0 on success, 1 on failure.

Environment variables:
  GOOGLE_API_KEY       — Gemini API key (required)
  MULTICA_API_URL      — Backend API base URL (default: http://localhost:8080)
  MULTICA_AGENT_TOKEN  — Agent auth token for API calls
  MULTICA_WORKSPACE_ID — Workspace ID for API calls
  MULTICA_MODEL        — Model override (default: gemini-2.5-flash)
  MULTICA_MAX_TURNS    — Max LLM calls (default: 20)
"""

import argparse
import asyncio
import json
import os
import sys
import time
import warnings

# Suppress warnings so they don't pollute NDJSON stdout.
warnings.filterwarnings("ignore")

from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from bridge import NDJSONEmitter
from tools import ALL_TOOLS


# ── System prompt ────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are an AI agent working in a project management platform called Multica.

## Your Role
You are assigned to issues and tasked with completing them autonomously. You have tools to interact with the platform: read issues, search for context, post comments, and update status.

## Workflow
1. Start by reading the assigned issue with get_issue to understand what's needed
2. Check comments with list_comments for any recent feedback or context
3. Search for related issues with search_issues if the task mentions dependencies
4. Do the work — research, analyze, write documents as needed
5. Post your findings or deliverables as a comment with add_comment
6. Update the issue status when done (e.g., to "done")

## Communication Style
- Be concise and professional in comments
- Use markdown formatting
- Reference specific issue IDs when discussing related work
- Include data, sources, and evidence — don't speculate

## Error Handling
- If a tool returns an error, try a different approach rather than retrying blindly
- If you can't complete the task, explain why in a comment and leave the status as-is

## Document Creation
- If the task asks for a report or document, create it using create_document (markdown), create_docx (Word), or create_xlsx (Excel)
- Save documents to /workspace/output/ — they'll be automatically attached to the issue
"""


# ── Max turns enforcement ────────────────────────────────────────────────────

def make_turn_limiter(max_turns: int):
    """Create a before_model_callback that enforces a max LLM call limit."""
    call_count = {"n": 0}

    def enforce_max_turns(callback_context, llm_request):
        call_count["n"] += 1
        if call_count["n"] > max_turns:
            print(f"[agent] max turns reached ({max_turns})", file=sys.stderr)
            from google.adk.models.llm_response import LlmResponse
            from google.genai import types as genai_types
            return LlmResponse(
                content=genai_types.Content(
                    role="model",
                    parts=[genai_types.Part.from_text(
                        text="I've reached the maximum number of steps allowed. Posting my findings so far."
                    )],
                ),
            )
        return None

    return enforce_max_turns


# ── Main ─────────────────────────────────────────────────────────────────────

async def run(task_id: str, issue_id: str, prompt: str, model: str, max_turns: int):
    api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GOOGLE_AI_API_KEY")
    if not api_key:
        emitter = NDJSONEmitter(task_id=task_id, issue_id=issue_id, model=model)
        emitter.emit_error("GOOGLE_API_KEY not set")
        emitter.emit_result("failed", "GOOGLE_API_KEY not set")
        return 1
    os.environ["GOOGLE_API_KEY"] = api_key

    emitter = NDJSONEmitter(task_id=task_id, issue_id=issue_id, model=model)

    # Google Search grounding runs server-side at Google — works inside Daytona
    # sandboxes since traffic goes through generativelanguage.googleapis.com.
    google_search_tool = types.Tool(google_search=types.GoogleSearch())

    agent = Agent(
        name="multica_agent",
        model=model,
        instruction=SYSTEM_PROMPT,
        tools=ALL_TOOLS + [google_search_tool],
        before_model_callback=make_turn_limiter(max_turns),
    )

    session_service = InMemorySessionService()
    runner = Runner(agent=agent, app_name="multica", session_service=session_service)
    session = await session_service.create_session(app_name="multica", user_id="daemon")

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
        print(f"[agent] error: {e}", file=sys.stderr)
        emitter.emit_error(str(e))
        emitter.emit_result("failed", str(e))
        return 1


def main():
    parser = argparse.ArgumentParser(description="Multica ADK Agent")
    parser.add_argument("--task-id", required=True, help="Task ID")
    parser.add_argument("--issue-id", default="", help="Issue ID")
    parser.add_argument("--prompt", required=True, help="Agent prompt")
    parser.add_argument("--model", default="", help="Model override")
    parser.add_argument("--max-turns", type=int, default=0, help="Max LLM calls")
    args = parser.parse_args()

    model = args.model or os.environ.get("MULTICA_MODEL", "gemini-2.5-flash")
    max_turns = args.max_turns or int(os.environ.get("MULTICA_MAX_TURNS", "20"))

    print(f"[agent] task={args.task_id} model={model} max_turns={max_turns}", file=sys.stderr)

    start = time.time()
    exit_code = asyncio.run(run(args.task_id, args.issue_id, args.prompt, model, max_turns))
    elapsed = round(time.time() - start, 2)

    print(f"[agent] done in {elapsed}s exit_code={exit_code}", file=sys.stderr)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
