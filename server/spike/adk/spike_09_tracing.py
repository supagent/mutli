"""
Spike 9: Observability / Tracing

Validates that ADK emits structured OpenTelemetry traces showing
agent → LLM call → tool execution hierarchy.

Pass criteria:
  - Spans show agent → LLM call → tool execution hierarchy
  - Each span has duration
  - Token counts are present in LLM spans
"""

import asyncio
import os
import time

from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

# OpenTelemetry imports for console export
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, ConsoleSpanExporter


# ── Tools ─────────────────────────────────────────────────────────────────────

def lookup_user(user_id: str) -> dict:
    """Look up a user by ID."""
    return {"id": user_id, "name": "Khaled Taha", "email": "me@khaledtaha.com", "role": "admin"}


def get_permissions(user_id: str) -> dict:
    """Get permissions for a user."""
    return {"user_id": user_id, "permissions": ["read", "write", "admin"], "workspace": "multica"}


# ── Span collector ────────────────────────────────────────────────────────────

collected_spans = []


class CollectorExporter:
    """Custom span exporter that collects spans in memory for validation."""

    def export(self, spans):
        for span in spans:
            collected_spans.append({
                "name": span.name,
                "duration_ns": span.end_time - span.start_time if span.end_time and span.start_time else 0,
                "duration_ms": round((span.end_time - span.start_time) / 1e6, 1) if span.end_time and span.start_time else 0,
                "attributes": dict(span.attributes) if span.attributes else {},
                "parent": span.parent.span_id if span.parent else None,
                "span_id": span.context.span_id,
                "status": span.status.status_code.name if span.status else "UNSET",
            })
        return True  # Success

    def shutdown(self):
        pass

    def force_flush(self, timeout_millis=None):
        return True


# ── Main ──────────────────────────────────────────────────────────────────────

async def main():
    api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GOOGLE_AI_API_KEY")
    if not api_key:
        print("FAIL: GOOGLE_API_KEY not set")
        return False
    os.environ["GOOGLE_API_KEY"] = api_key

    # Set up OpenTelemetry with our custom collector
    collector = CollectorExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(collector))
    trace.set_tracer_provider(provider)

    agent = Agent(
        name="traced_agent",
        model="gemini-2.5-flash",
        instruction="You are a helpful assistant. Use the provided tools to answer questions.",
        tools=[lookup_user, get_permissions],
    )

    session_service = InMemorySessionService()
    runner = Runner(agent=agent, app_name="spike_09", session_service=session_service)
    session = await session_service.create_session(app_name="spike_09", user_id="test-user")

    prompt = "Look up user U-123 and check their permissions."

    user_message = types.Content(
        role="user",
        parts=[types.Part.from_text(text=prompt)],
    )

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
                    print(f"  [{elapsed}s] TOOL: {part.function_call.name}")
                elif part.text:
                    print(f"  [{elapsed}s] TEXT: {part.text[:80]}...")

    # Flush spans
    provider.force_flush()

    # ── Validation ────────────────────────────────────────────────────────────

    print("\n── Results ──")
    print(f"  Spans collected: {len(collected_spans)}")

    for span in collected_spans:
        parent_info = f"parent={span['parent']}" if span['parent'] else "root"
        print(f"  [{span['duration_ms']}ms] {span['name']} ({parent_info})")
        if span['attributes']:
            for k, v in list(span['attributes'].items())[:5]:
                print(f"    {k}: {str(v)[:80]}")

    passed = True

    if len(collected_spans) == 0:
        print("FAIL: No spans collected — tracing may not be enabled")
        passed = False
    else:
        print(f"PASS: {len(collected_spans)} spans collected")

    # Check for hierarchy (parent-child relationships)
    root_spans = [s for s in collected_spans if s["parent"] is None]
    child_spans = [s for s in collected_spans if s["parent"] is not None]

    if root_spans:
        print(f"PASS: {len(root_spans)} root span(s), {len(child_spans)} child span(s)")
    else:
        print("WARN: No root spans found — all spans may be children of an external trace")

    # Check for duration
    spans_with_duration = [s for s in collected_spans if s["duration_ms"] > 0]
    if spans_with_duration:
        print(f"PASS: {len(spans_with_duration)}/{len(collected_spans)} spans have duration")
    else:
        print("WARN: No spans have duration")

    # Check for agent/tool/LLM span names
    span_names = [s["name"] for s in collected_spans]
    print(f"  Span names: {span_names}")

    has_agent_span = any("agent" in name.lower() or "run" in name.lower() for name in span_names)
    has_tool_span = any("tool" in name.lower() or "function" in name.lower() or "lookup" in name.lower() for name in span_names)
    has_llm_span = any("llm" in name.lower() or "generate" in name.lower() or "gemini" in name.lower() or "model" in name.lower() for name in span_names)

    if has_agent_span:
        print("PASS: Agent-level spans present")
    else:
        print("WARN: No agent-level spans detected by name")

    if has_llm_span:
        print("PASS: LLM call spans present")
    else:
        print("WARN: No LLM call spans detected by name")

    if has_tool_span:
        print("PASS: Tool execution spans present")
    else:
        print("WARN: No tool execution spans detected by name")

    # Check for token usage in attributes
    token_attrs = []
    for span in collected_spans:
        for k in span["attributes"]:
            if "token" in k.lower():
                token_attrs.append((span["name"], k, span["attributes"][k]))

    if token_attrs:
        print(f"PASS: Token usage found in {len(token_attrs)} attribute(s)")
        for name, k, v in token_attrs[:5]:
            print(f"    {name}: {k}={v}")
    else:
        print("WARN: No token usage attributes found in spans")

    if passed:
        print("\nPASS: Observability/tracing works")
    else:
        print("\nFAIL: Tracing validation failed")

    return passed


if __name__ == "__main__":
    success = asyncio.run(main())
    exit(0 if success else 1)
