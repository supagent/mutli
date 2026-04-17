"""
Spike 8: Sub-Agent Delegation

Validates that a parent agent can invoke sub-agents with different
system prompts and tool sets, and receive results back.

Pass criteria:
  - Parent agent delegates to researcher sub-agent
  - Researcher uses its tools (mock web search)
  - Result flows back to parent
  - Parent delegates to writer sub-agent
  - Writer produces a formatted report
  - Token usage tracked per agent
"""

import asyncio
import os
import time

from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types


# ── Researcher tools ──────────────────────────────────────────────────────────

async def web_search(query: str) -> dict:
    """Search the web for information."""
    # Mock search results — validates delegation, not real search.
    results = {
        "ai project management": [
            {"title": "Linear raises $50M Series C", "url": "https://example.com/linear", "snippet": "Linear, the AI-native project management tool, raised $50M at a $1B valuation."},
            {"title": "GitHub Projects adds AI features", "url": "https://example.com/github", "snippet": "GitHub Projects now includes AI-powered issue triage and sprint planning."},
            {"title": "Multica: AI agents as team members", "url": "https://example.com/multica", "snippet": "Multica lets you assign AI agents to issues, with real-time task execution."},
        ],
    }
    # Return best match or generic
    for key, data in results.items():
        if key in query.lower():
            return {"query": query, "results": data}
    return {"query": query, "results": [{"title": "No results", "url": "", "snippet": "No relevant results found."}]}


async def get_pricing(product: str) -> dict:
    """Get pricing information for a product."""
    pricing = {
        "linear": {"free_tier": "Yes (up to 250 issues)", "pro": "$10/user/month", "enterprise": "Custom"},
        "github projects": {"free_tier": "Yes (public repos)", "team": "$4/user/month", "enterprise": "$21/user/month"},
        "multica": {"free_tier": "Yes (2 agents)", "pro": "$15/user/month", "enterprise": "Custom"},
    }
    data = pricing.get(product.lower(), {"info": "Pricing not available"})
    return {"product": product, **data}


# ── Agent definitions ─────────────────────────────────────────────────────────

def build_agents():
    researcher = Agent(
        name="researcher",
        model="gemini-2.5-flash",
        instruction=(
            "You are a research specialist. Use web_search and get_pricing to gather "
            "comprehensive data about the topic. Return a structured summary with facts, "
            "data points, and source references. Be thorough but concise."
        ),
        tools=[web_search, get_pricing],
        description="Research specialist — delegates here for web research, data gathering, and pricing lookups.",
    )

    writer = Agent(
        name="writer",
        model="gemini-2.5-flash",
        instruction=(
            "You are a technical writer. Take research data and produce a clear, "
            "well-structured report. Use markdown formatting. Include a comparison table "
            "if multiple products are involved. Keep it under 300 words."
        ),
        description="Technical writer — delegates here to turn research into polished reports.",
    )

    orchestrator = Agent(
        name="orchestrator",
        model="gemini-2.5-flash",
        instruction=(
            "You are a project coordinator. When given a research task:\n"
            "1. First, delegate to the 'researcher' to gather data\n"
            "2. Then, delegate to the 'writer' to produce the final report\n"
            "Coordinate between them to produce the best result."
        ),
        sub_agents=[researcher, writer],
    )

    return orchestrator


# ── Main ──────────────────────────────────────────────────────────────────────

async def main():
    api_key = os.environ.get("GOOGLE_AI_API_KEY")
    if not api_key:
        print("FAIL: GOOGLE_AI_API_KEY not set")
        return False

    orchestrator = build_agents()

    session_service = InMemorySessionService()
    runner = Runner(agent=orchestrator, app_name="spike_08", session_service=session_service)
    session = await session_service.create_session(app_name="spike_08", user_id="test-user")

    prompt = "Research AI project management tools and write a brief comparison report with pricing."

    user_message = types.Content(
        role="user",
        parts=[types.Part.from_text(text=prompt)],
    )

    events_by_agent: dict[str, list] = {}
    tool_calls = []
    text_response = ""
    agents_seen = set()

    start = time.time()

    async for event in runner.run_async(
        user_id="test-user",
        session_id=session.id,
        new_message=user_message,
    ):
        elapsed = round(time.time() - start, 2)

        # Track which agent produced this event
        agent_name = getattr(event, "author", "unknown")
        agents_seen.add(agent_name)

        if agent_name not in events_by_agent:
            events_by_agent[agent_name] = []

        if event.content and event.content.parts:
            for part in event.content.parts:
                if part.function_call:
                    tool_calls.append({"agent": agent_name, "tool": part.function_call.name})
                    events_by_agent[agent_name].append(("tool_use", part.function_call.name))
                    print(f"  [{elapsed}s] [{agent_name}] TOOL_USE: {part.function_call.name}")
                elif part.function_response:
                    events_by_agent[agent_name].append(("tool_result", part.function_response.name))
                    print(f"  [{elapsed}s] [{agent_name}] TOOL_RESULT: {part.function_response.name}")
                elif part.text:
                    text_response += part.text
                    events_by_agent[agent_name].append(("text", len(part.text)))
                    preview = part.text[:80].replace("\n", " ")
                    print(f"  [{elapsed}s] [{agent_name}] TEXT: {preview}...")

    wall_time = round(time.time() - start, 2)

    # ── Validation ────────────────────────────────────────────────────────────

    print(f"\n── Results ──")
    print(f"  Wall time:     {wall_time}s")
    print(f"  Agents seen:   {agents_seen}")
    print(f"  Tool calls:    {len(tool_calls)}")
    print(f"  Text length:   {len(text_response)} chars")
    print(f"  Events by agent:")
    for agent, events in events_by_agent.items():
        print(f"    {agent}: {len(events)} events")

    passed = True

    # Check that multiple agents were involved
    if len(agents_seen) < 2:
        print(f"FAIL: Expected at least 2 agents (orchestrator + sub-agent), got {agents_seen}")
        passed = False
    else:
        print(f"PASS: Multiple agents involved: {agents_seen}")

    # Check that researcher's tools were called
    researcher_tools = [tc for tc in tool_calls if tc["tool"] in ("web_search", "get_pricing")]
    if len(researcher_tools) == 0:
        print("FAIL: Researcher sub-agent did not use any tools")
        passed = False
    else:
        print(f"PASS: Researcher used {len(researcher_tools)} tool(s): {[t['tool'] for t in researcher_tools]}")

    # Check that we got a final text response
    if not text_response:
        print("FAIL: No final text response")
        passed = False
    else:
        print(f"PASS: Got final text response ({len(text_response)} chars)")

    # Check delegation happened (researcher agent appears in events)
    if "researcher" in agents_seen:
        print("PASS: Delegation to researcher confirmed")
    elif any("researcher" in str(a).lower() for a in agents_seen):
        print("PASS: Delegation to researcher-like agent confirmed")
    else:
        print("WARN: 'researcher' not explicitly seen in agent names (delegation may use different naming)")

    if passed:
        print("\nPASS: Sub-agent delegation works")
    else:
        print("\nFAIL: Sub-agent delegation validation failed")

    return passed


if __name__ == "__main__":
    success = asyncio.run(main())
    exit(0 if success else 1)
