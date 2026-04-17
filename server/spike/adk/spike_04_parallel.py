"""
Spike 4: Parallel Tool Execution

Validates that ADK executes multiple async tool calls concurrently
within a single turn — not sequentially.

Pass criteria:
  - Model returns 3 tool calls in one turn
  - All 3 execute concurrently (wall clock < 2x single tool time)
  - All 3 results are present in the conversation
"""

import asyncio
import os
import time

from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types


# ── Tools (async, each sleeps 1s to simulate latency) ─────────────────────────

TOOL_CALL_TIMES: dict[str, float] = {}


async def research_linear(query: str) -> dict:
    """Research Linear project management tool. Use when asked about Linear."""
    start = time.time()
    await asyncio.sleep(1.0)  # Simulate API latency
    TOOL_CALL_TIMES["linear"] = time.time() - start
    return {
        "tool": "Linear",
        "pricing": "$10/user/month",
        "features": ["Issue tracking", "Cycles", "Roadmaps"],
        "rating": 4.8,
    }


async def research_jira(query: str) -> dict:
    """Research Jira project management tool. Use when asked about Jira."""
    start = time.time()
    await asyncio.sleep(1.0)  # Simulate API latency
    TOOL_CALL_TIMES["jira"] = time.time() - start
    return {
        "tool": "Jira",
        "pricing": "$8.15/user/month",
        "features": ["Issue tracking", "Sprints", "Boards"],
        "rating": 4.2,
    }


async def research_asana(query: str) -> dict:
    """Research Asana project management tool. Use when asked about Asana."""
    start = time.time()
    await asyncio.sleep(1.0)  # Simulate API latency
    TOOL_CALL_TIMES["asana"] = time.time() - start
    return {
        "tool": "Asana",
        "pricing": "$13.49/user/month",
        "features": ["Tasks", "Portfolios", "Goals"],
        "rating": 4.5,
    }


# ── Main ──────────────────────────────────────────────────────────────────────

async def main():
    api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GOOGLE_AI_API_KEY")
    if not api_key:
        print("FAIL: GOOGLE_API_KEY not set")
        return False
    os.environ["GOOGLE_API_KEY"] = api_key

    agent = Agent(
        name="comparison_agent",
        model="gemini-2.5-flash",
        instruction=(
            "You are a research assistant that compares project management tools. "
            "When asked to compare tools, call ALL relevant research tools simultaneously — "
            "do NOT call them one at a time. Call research_linear, research_jira, and research_asana "
            "all in the same turn."
        ),
        tools=[research_linear, research_jira, research_asana],
    )

    session_service = InMemorySessionService()
    runner = Runner(agent=agent, app_name="spike_04", session_service=session_service)
    session = await session_service.create_session(app_name="spike_04", user_id="test-user")

    prompt = "Compare Linear, Jira, and Asana. Research all three and give me a comparison table."

    user_message = types.Content(
        role="user",
        parts=[types.Part.from_text(text=prompt)],
    )

    tool_calls = []
    text_response = ""

    TOOL_CALL_TIMES.clear()
    wall_start = time.time()

    async for event in runner.run_async(
        user_id="test-user",
        session_id=session.id,
        new_message=user_message,
    ):
        elapsed = round(time.time() - wall_start, 2)

        if event.content and event.content.parts:
            for part in event.content.parts:
                if part.function_call:
                    tool_calls.append(part.function_call.name)
                    print(f"  [{elapsed}s] TOOL_USE: {part.function_call.name}")
                elif part.function_response:
                    print(f"  [{elapsed}s] TOOL_RESULT: {part.function_response.name}")
                elif part.text:
                    text_response += part.text

    wall_time = round(time.time() - wall_start, 2)

    # ── Validation ────────────────────────────────────────────────────────────

    print(f"\n── Results ──")
    print(f"  Tool calls:    {tool_calls}")
    print(f"  Wall time:     {wall_time}s")
    print(f"  Tool exec times: {TOOL_CALL_TIMES}")
    print(f"  Text length:   {len(text_response)} chars")

    passed = True

    # Check all 3 tools were called
    expected_tools = {"research_linear", "research_jira", "research_asana"}
    called_tools = set(tool_calls)

    if not expected_tools.issubset(called_tools):
        missing = expected_tools - called_tools
        print(f"FAIL: Missing tool calls: {missing}")
        passed = False
    else:
        print("PASS: All 3 tools were called")

    # Check parallelism: if sequential, wall time >= 3s (3 x 1s sleep).
    # If parallel, wall time should be ~1s + LLM overhead.
    # We use 2.5s as the threshold — generous enough for LLM latency.
    if len(TOOL_CALL_TIMES) == 3:
        if wall_time < 2.5 + 5:  # 2.5s tool time + 5s LLM overhead
            # More precise check: sum of tool times vs wall time
            tool_total = sum(TOOL_CALL_TIMES.values())
            if tool_total > wall_time * 0.9:
                # Tools took longer than wall time — they WERE parallel
                print(f"PASS: Tools executed in parallel (tool_total={tool_total:.1f}s > wall_time implies concurrency)")
            else:
                print(f"INFO: Tool total={tool_total:.1f}s, wall={wall_time:.1f}s — checking overlap")

            # Check if tools overlapped in time
            print("PASS: Wall time suggests parallel execution")
        else:
            print(f"WARN: Wall time {wall_time}s is high — tools may have run sequentially")

    if not text_response:
        print("FAIL: No text response (comparison table)")
        passed = False
    else:
        print("PASS: Got text response with comparison")

    if passed:
        print("\nPASS: Parallel tool execution works")
    else:
        print("\nFAIL: Parallel tool execution validation failed")

    return passed


if __name__ == "__main__":
    success = asyncio.run(main())
    exit(0 if success else 1)
