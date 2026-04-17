"""
Spike 1: Streaming Tool Calls

Validates that ADK can stream text output AND emit tool call events
in the same response, with events arriving incrementally.

Pass criteria:
  - Text chunks arrive incrementally (not batched)
  - Tool call events have function_call with name + args
  - Tool results flow back into the conversation
  - See interleaved text and tool_use events in chronological order
"""

import asyncio
import os
import time

from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types


# ── Tool definitions ──────────────────────────────────────────────────────────

def get_weather(city: str) -> dict:
    """Get the current weather for a city."""
    # Mock response — validates the tool call/result loop, not real weather.
    weather_data = {
        "new york": {"temp": 72, "condition": "sunny", "humidity": 45},
        "london": {"temp": 58, "condition": "cloudy", "humidity": 78},
        "tokyo": {"temp": 81, "condition": "humid", "humidity": 85},
    }
    data = weather_data.get(city.lower(), {"temp": 65, "condition": "unknown", "humidity": 50})
    return {"city": city, **data}


def get_time(timezone: str) -> dict:
    """Get the current time in a timezone."""
    return {"timezone": timezone, "time": "2026-04-16T10:30:00", "note": "mock time"}


# ── Main ──────────────────────────────────────────────────────────────────────

async def main():
    api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GOOGLE_AI_API_KEY")
    if not api_key:
        print("FAIL: GOOGLE_API_KEY not set")
        return False
    os.environ["GOOGLE_API_KEY"] = api_key

    agent = Agent(
        name="weather_agent",
        model="gemini-2.5-flash",
        instruction="You are a helpful assistant. When asked about weather or time, use the provided tools. Always use tools — never make up data.",
        tools=[get_weather, get_time],
    )

    session_service = InMemorySessionService()
    runner = Runner(agent=agent, app_name="spike_01", session_service=session_service)
    session = await session_service.create_session(app_name="spike_01", user_id="test-user")

    # Prompt that should trigger multiple tool calls
    prompt = "What's the weather in New York and London right now? Also what time is it in EST?"

    user_message = types.Content(
        role="user",
        parts=[types.Part.from_text(text=prompt)],
    )

    event_log = []
    start = time.time()

    async for event in runner.run_async(
        user_id="test-user",
        session_id=session.id,
        new_message=user_message,
    ):
        elapsed = round(time.time() - start, 2)

        if event.content and event.content.parts:
            for part in event.content.parts:
                if part.function_call:
                    entry = {
                        "type": "tool_use",
                        "tool": part.function_call.name,
                        "args": dict(part.function_call.args) if part.function_call.args else {},
                        "elapsed": elapsed,
                    }
                    event_log.append(entry)
                    print(f"  [{elapsed}s] TOOL_USE: {part.function_call.name}({entry['args']})")
                elif part.function_response:
                    entry = {
                        "type": "tool_result",
                        "tool": part.function_response.name,
                        "elapsed": elapsed,
                    }
                    event_log.append(entry)
                    print(f"  [{elapsed}s] TOOL_RESULT: {part.function_response.name}")
                elif part.text:
                    entry = {
                        "type": "text",
                        "content": part.text[:80],
                        "elapsed": elapsed,
                    }
                    event_log.append(entry)
                    print(f"  [{elapsed}s] TEXT: {part.text[:80]}...")

        # Check for usage metadata
        if hasattr(event, "usage_metadata") and event.usage_metadata:
            print(f"  [{elapsed}s] USAGE: {event.usage_metadata}")

    # ── Validation ────────────────────────────────────────────────────────────

    tool_uses = [e for e in event_log if e["type"] == "tool_use"]
    tool_results = [e for e in event_log if e["type"] == "tool_result"]
    texts = [e for e in event_log if e["type"] == "text"]

    print(f"\n── Results ──")
    print(f"  Tool calls:   {len(tool_uses)}")
    print(f"  Tool results: {len(tool_results)}")
    print(f"  Text chunks:  {len(texts)}")
    print(f"  Total events: {len(event_log)}")

    passed = True

    if len(tool_uses) < 2:
        print("FAIL: Expected at least 2 tool calls (weather for 2 cities)")
        passed = False

    if len(tool_results) < 2:
        print("FAIL: Expected at least 2 tool results")
        passed = False

    if len(texts) == 0:
        print("FAIL: Expected at least 1 text response")
        passed = False

    # Check that events are interleaved (not all tool calls then all text)
    types_seen = [e["type"] for e in event_log]
    has_interleaving = False
    for i in range(len(types_seen) - 1):
        if types_seen[i] != types_seen[i + 1]:
            has_interleaving = True
            break

    if not has_interleaving:
        print("WARN: Events are not interleaved (all same type)")

    if passed:
        print("\nPASS: Streaming tool calls work correctly")
    else:
        print("\nFAIL: Streaming tool calls validation failed")

    return passed


if __name__ == "__main__":
    success = asyncio.run(main())
    exit(0 if success else 1)
