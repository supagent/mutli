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
You are assigned to issues and tasked with completing them autonomously. The issue title and description are provided in the user message — you already have the task content. You also have tools to interact with the platform when needed.

## Workflow
1. Read the task in the user message — it contains the issue title and description
2. Do the work — research, analyze, write documents as needed
3. If you need more context, use get_issue or list_comments to check for updates
4. Post your findings or deliverables as a comment with add_comment (if the API is reachable)
5. If API tools fail, just respond with your answer directly — that's fine

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

def _load_sub_agents(path: str, model: str, max_turns: int, tools: list | None = None) -> list:
    """Load sub-agent definitions from JSON and construct ADK Agent objects."""
    if not path or not os.path.exists(path):
        return []

    with open(path) as f:
        defs = json.load(f)

    agent_tools = tools if tools is not None else ALL_TOOLS
    sub_agents = []
    for sa_def in defs:
        sub_agents.append(Agent(
            name=sa_def["name"],
            model=model,
            instruction=sa_def.get("instructions", ""),
            description=sa_def.get("description", ""),
            tools=agent_tools,
            before_model_callback=make_turn_limiter(max_turns),
        ))
        print(f"[agent] loaded sub-agent: {sa_def['name']}", file=sys.stderr)

    return sub_agents


async def run(task_id: str, issue_id: str, prompt: str, model: str, max_turns: int, sub_agents_path: str = "", system_prompt_extra: str = "", task_role: str = ""):
    api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GOOGLE_AI_API_KEY")
    if not api_key:
        emitter = NDJSONEmitter(task_id=task_id, issue_id=issue_id, model=model)
        emitter.emit_error("GOOGLE_API_KEY not set")
        emitter.emit_result("failed", "GOOGLE_API_KEY not set")
        return 1
    os.environ["GOOGLE_API_KEY"] = api_key

    emitter = NDJSONEmitter(task_id=task_id, issue_id=issue_id, model=model)

    # Compute tool restrictions based on task role.
    from tools import create_child_task as _cct, add_comment as _ac, update_issue as _ui
    agent_tools = list(ALL_TOOLS)

    # Workers must not post comments or change issue status — their output
    # flows to the orchestrator via synthesis. Enforced at the tool level
    # because prompt-level instructions are unreliable.
    if task_role == "worker":
        agent_tools = [t for t in agent_tools if t not in (_ac, _ui, _cct)]

    # Load sub-agent definitions for multi-agent orchestration.
    # Sub-agents receive the same filtered tools as the parent.
    has_sub_agents = bool(sub_agents_path and os.path.exists(sub_agents_path))
    if has_sub_agents:
        # Phase 1 (sub_agents) and Phase 2 (create_child_task) are mutually exclusive.
        agent_tools = [t for t in agent_tools if t is not _cct]

    try:
        sub_agents = _load_sub_agents(sub_agents_path, model, max_turns, tools=agent_tools)
    except Exception as e:
        print(f"[agent] failed to load sub-agents: {e}", file=sys.stderr)
        emitter.emit_error(f"Failed to load sub-agents: {e}")
        sub_agents = []


    # Combine base system prompt with agent-specific instructions from the DB.
    instruction = SYSTEM_PROMPT
    if system_prompt_extra:
        instruction += f"\n\n## Agent-Specific Instructions\n{system_prompt_extra}\n"

    agent = Agent(
        name="multica_agent",
        model=model,
        instruction=instruction,
        tools=agent_tools,
        before_model_callback=make_turn_limiter(max_turns),
        **({"sub_agents": sub_agents} if sub_agents else {}),
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
            # Extract sub-agent attribution for multi-agent orchestration.
            agent_name = getattr(event, "author", "") or ""

            if event.content and event.content.parts:
                for part in event.content.parts:
                    if part.function_call:
                        args = dict(part.function_call.args) if part.function_call.args else {}
                        emitter.emit_tool_use(part.function_call.name, args, agent_name=agent_name)
                    elif part.function_response:
                        output = json.dumps(dict(part.function_response.response)) if part.function_response.response else ""
                        emitter.emit_tool_result(part.function_response.name, output, agent_name=agent_name)
                    elif part.text:
                        accumulated_text += part.text
                        emitter.emit_text(part.text, agent_name=agent_name)

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
    parser.add_argument("--sub-agents", default="", help="Path to sub-agents JSON file")
    parser.add_argument("--system-prompt", default="", help="Additional agent instructions from DB")
    parser.add_argument("--role", default="", help="Task role: orchestrator, worker, synthesizer")
    args = parser.parse_args()

    model = args.model or os.environ.get("MULTICA_MODEL", "gemini-2.5-flash")
    max_turns = args.max_turns if args.max_turns > 0 else int(os.environ.get("MULTICA_MAX_TURNS", "20"))

    sub_agents_path = args.sub_agents
    system_prompt_extra = args.system_prompt
    task_role = args.role
    print(f"[agent] task={args.task_id} model={model} max_turns={max_turns} sub_agents={sub_agents_path or 'none'} role={task_role or 'none'}", file=sys.stderr)

    start = time.time()
    exit_code = asyncio.run(run(args.task_id, args.issue_id, args.prompt, model, max_turns, sub_agents_path, system_prompt_extra, task_role))
    elapsed = round(time.time() - start, 2)

    print(f"[agent] done in {elapsed}s exit_code={exit_code}", file=sys.stderr)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
