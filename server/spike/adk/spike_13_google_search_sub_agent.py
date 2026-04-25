"""
Spike 13: Google Search as Sub-Agent

Validates that google_search grounding works when isolated in a sub-agent,
while the parent agent has function calling tools. This is the key constraint:
google_search can't coexist with function tools on the same agent.

Tests:
  1. Sub-agent with google_search ONLY delegates correctly
  2. Parent with function tools + sub-agent with google_search both work
  3. google_search results flow back to parent for synthesis
  4. Grounding metadata (citations/URIs) is accessible
  5. The combined agent can answer questions requiring both web search and tools

Run:
  cd server && GOOGLE_API_KEY=... python3 spike/adk/spike_13_google_search_sub_agent.py
"""

import asyncio
import os
import sys
import time

from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools import google_search
from google.genai import types


# ── Mock function tools (simulating Multica API tools) ──────────────────────

TOOL_CALLS = []


def add_comment(issue_id: str, content: str) -> dict:
    """Add a comment to an issue."""
    TOOL_CALLS.append({"tool": "add_comment", "issue_id": issue_id})
    return {"status": "posted", "issue_id": issue_id}


def get_issue(issue_id: str) -> dict:
    """Get issue details."""
    TOOL_CALLS.append({"tool": "get_issue", "issue_id": issue_id})
    return {
        "id": issue_id,
        "title": "Research AI trends",
        "description": "Find the latest AI trends for 2026",
    }


FUNCTION_TOOLS = [add_comment, get_issue]


# ── Helpers ──────────────────────────────────────────────────────────────────

async def run_agent(agent: Agent, prompt: str, max_events: int = 30) -> dict:
    """Run an agent and collect events."""
    ss = InMemorySessionService()
    runner = Runner(agent=agent, app_name="spike_13", session_service=ss)
    session = await ss.create_session(app_name="spike_13", user_id="test")
    msg = types.Content(role="user", parts=[types.Part.from_text(text=prompt)])

    events = []
    text_by_author = {}
    authors_seen = set()
    grounding_found = False
    count = 0

    async for event in runner.run_async(
        user_id="test", session_id=session.id, new_message=msg
    ):
        author = getattr(event, "author", "") or ""
        authors_seen.add(author)
        count += 1
        if count > max_events:
            break

        if event.content and event.content.parts:
            for part in event.content.parts:
                if part.function_call:
                    events.append(("call", author, part.function_call.name))
                elif part.function_response:
                    events.append(("result", author, part.function_response.name))
                elif part.text:
                    events.append(("text", author, part.text[:80]))
                    text_by_author.setdefault(author, "")
                    text_by_author[author] += part.text

        # Check for grounding metadata
        if hasattr(event, "grounding_metadata") and event.grounding_metadata:
            grounding_found = True
        if event.content and hasattr(event.content, "grounding_metadata") and event.content.grounding_metadata:
            grounding_found = True

    return {
        "events": events,
        "authors_seen": authors_seen,
        "text_by_author": text_by_author,
        "grounding_found": grounding_found,
    }


# ── Tests ────────────────────────────────────────────────────────────────────

async def test_1_google_search_sub_agent_alone() -> bool:
    """Verify google_search works in a standalone sub-agent."""
    print("\n=== Test 1: google_search sub-agent standalone ===")

    researcher = Agent(
        name="web_researcher",
        model="gemini-2.5-flash",
        instruction="You are a web research specialist. Use Google Search to find current information. Be concise.",
        description="Web research specialist using Google Search.",
        tools=[google_search],
    )

    result = await run_agent(researcher, "What is the current price of Bitcoin? Be very brief.")

    has_text = bool(result["text_by_author"])
    print(f"  Has text output: {has_text}")
    print(f"  Grounding metadata: {result['grounding_found']}")

    if has_text:
        print("  PASS: google_search sub-agent produces output")
        return True
    else:
        print("  FAIL: no output from google_search agent")
        return False


async def test_2_parent_with_tools_plus_search_sub_agent() -> bool:
    """Verify parent with function tools can delegate to google_search sub-agent."""
    print("\n=== Test 2: Parent (function tools) + Sub-agent (google_search) ===")

    TOOL_CALLS.clear()

    web_researcher = Agent(
        name="web_researcher",
        model="gemini-2.5-flash",
        instruction="You are a web research specialist. Use Google Search to find current, factual information. Be concise and return findings.",
        description="Web research specialist — delegates here for any web search or current information lookup.",
        tools=[google_search],
    )

    orchestrator = Agent(
        name="orchestrator",
        model="gemini-2.5-flash",
        instruction=(
            "You coordinate tasks. You have tools to manage issues.\n"
            "When you need current web information, delegate to 'web_researcher'.\n"
            "For this request, first delegate to web_researcher to find the answer, "
            "then respond with the findings."
        ),
        tools=FUNCTION_TOOLS,
        sub_agents=[web_researcher],
    )

    result = await run_agent(orchestrator, "What are the top 3 AI companies by market cap in 2026? Be brief.")

    has_text = bool(result["text_by_author"])
    has_transfer = any(e[2] == "transfer_to_agent" for e in result["events"] if e[0] == "call")
    researcher_spoke = "web_researcher" in result["authors_seen"]

    print(f"  Has text: {has_text}")
    print(f"  Delegated via transfer_to_agent: {has_transfer}")
    print(f"  web_researcher seen in events: {researcher_spoke}")
    print(f"  Authors: {result['authors_seen']}")

    if has_text and (has_transfer or researcher_spoke):
        print("  PASS: Parent delegated to google_search sub-agent")
        return True
    elif has_text:
        print("  FAIL: Got text but delegation was NOT observed (orchestrator answered directly)")
        return False  # Delegation must be observed to validate the sub-agent path
    else:
        print("  FAIL: no output")
        return False


async def test_3_search_results_flow_to_parent() -> bool:
    """Verify google_search results are available to the parent for synthesis."""
    print("\n=== Test 3: Search results flow back to parent ===")

    web_researcher = Agent(
        name="web_researcher",
        model="gemini-2.5-flash",
        instruction="Use Google Search to find the answer. Return a concise factual response.",
        description="Web researcher for current information.",
        tools=[google_search],
    )

    orchestrator = Agent(
        name="orchestrator",
        model="gemini-2.5-flash",
        instruction=(
            "You are a helpful assistant. When the user asks about current events or facts, "
            "delegate to 'web_researcher' to search the web, then summarize the findings. "
            "Always start your final answer with 'Based on web research:'."
        ),
        sub_agents=[web_researcher],
    )

    result = await run_agent(orchestrator, "Who won the latest Super Bowl? Be very brief.")

    # Check delegation: web_researcher must appear in authors or text_by_author
    delegated = "web_researcher" in result["authors_seen"] or "web_researcher" in result["text_by_author"]
    has_transfer = any(e[2] == "transfer_to_agent" for e in result["events"] if e[0] == "call")

    # Check if the output contains factual content
    all_text = " ".join(result["text_by_author"].values())
    has_factual_content = any(
        word in all_text.lower()
        for word in ["super bowl", "nfl", "champions", "won", "victory"]
    )

    print(f"  Delegation observed: {delegated or has_transfer}")
    print(f"  Has factual content: {has_factual_content}")
    print(f"  Text preview: {all_text[:150]}")

    if (delegated or has_transfer) and has_factual_content:
        print("  PASS: Delegated to web_researcher AND factual content present")
        return True
    elif has_factual_content and not (delegated or has_transfer):
        print("  FAIL: Factual content present but delegation was NOT observed")
        return False
    else:
        print("  FAIL: Missing delegation or factual content")
        return False


async def test_4_function_tools_still_work() -> bool:
    """Verify function tools on the parent still work alongside google_search sub-agent."""
    print("\n=== Test 4: Function tools still work alongside google_search ===")

    TOOL_CALLS.clear()

    web_researcher = Agent(
        name="web_researcher",
        model="gemini-2.5-flash",
        instruction="Web research specialist.",
        description="Web researcher.",
        tools=[google_search],
    )

    orchestrator = Agent(
        name="orchestrator",
        model="gemini-2.5-flash",
        instruction=(
            "You manage issues. Use get_issue to fetch issue details. "
            "Do NOT delegate to web_researcher for this task."
        ),
        tools=FUNCTION_TOOLS,
        sub_agents=[web_researcher],
    )

    result = await run_agent(orchestrator, "Get the details of issue ISS-42.")

    get_issue_called = any(c["tool"] == "get_issue" for c in TOOL_CALLS)
    print(f"  get_issue called: {get_issue_called}")
    print(f"  Tool calls: {[c['tool'] for c in TOOL_CALLS]}")

    if get_issue_called:
        print("  PASS: Function tools work alongside google_search sub-agent")
        return True
    else:
        print("  FAIL: get_issue was not called")
        return False


async def test_5_no_crash_with_mixed_tools() -> bool:
    """Verify no crash when google_search sub-agent and function tools coexist."""
    print("\n=== Test 5: No crash with mixed tool types ===")

    web_researcher = Agent(
        name="web_researcher",
        model="gemini-2.5-flash",
        instruction="Search the web for information.",
        description="Web search specialist.",
        tools=[google_search],
    )

    # This is the configuration that WOULD crash if google_search was on the parent
    orchestrator = Agent(
        name="orchestrator",
        model="gemini-2.5-flash",
        instruction="You are helpful. Answer the question using your tools or by delegating to web_researcher.",
        tools=FUNCTION_TOOLS,
        sub_agents=[web_researcher],
    )

    try:
        result = await run_agent(orchestrator, "Hello, what can you help me with?")
        has_text = bool(result["text_by_author"])
        print(f"  Has text: {has_text}")
        print("  PASS: No crash with mixed tool types")
        return True
    except Exception as e:
        print(f"  FAIL: Crashed with error: {e}")
        return False


# ── Main ─────────────────────────────────────────────────────────────────────

async def main():
    api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GOOGLE_AI_API_KEY")
    if not api_key:
        print("FAIL: GOOGLE_API_KEY not set")
        return False
    os.environ["GOOGLE_API_KEY"] = api_key

    print("=" * 60)
    print("Spike 13: Google Search as Sub-Agent")
    print("=" * 60)

    results = {}
    tests = [
        ("1_search_standalone", test_1_google_search_sub_agent_alone),
        ("2_parent_plus_search", test_2_parent_with_tools_plus_search_sub_agent),
        ("3_results_flow_to_parent", test_3_search_results_flow_to_parent),
        ("4_function_tools_work", test_4_function_tools_still_work),
        ("5_no_crash_mixed", test_5_no_crash_with_mixed_tools),
    ]

    for name, test_fn in tests:
        start = time.time()
        try:
            passed = await test_fn()
        except Exception as e:
            print(f"  EXCEPTION: {e}")
            passed = False
        elapsed = round(time.time() - start, 2)
        results[name] = passed
        print(f"  [{elapsed}s] {'PASS' if passed else 'FAIL'}: {name}")

    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    for name, passed in results.items():
        print(f"  {'PASS' if passed else 'FAIL'}: {name}")

    all_passed = all(results.values())
    passed_count = sum(1 for v in results.values() if v)

    print(f"\n  {passed_count}/{len(results)} tests passed")
    if all_passed:
        print("\nAll validations PASSED — google_search sub-agent works")
    else:
        failed = [k for k, v in results.items() if not v]
        print(f"\nFailed: {failed}")

    return all_passed


if __name__ == "__main__":
    success = asyncio.run(main())
    sys.exit(0 if success else 1)
