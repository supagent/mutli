"""
Spike 6: Structured Output / Schema Enforcement

Validates that ADK can constrain the model's output to a Pydantic schema
while still allowing tool use in the same conversation.

Pass criteria:
  - Agent uses tools to gather data
  - Final output validates against the Pydantic model
  - Enum values are constrained (no invalid values)
  - Tools and output_schema work together
"""

import asyncio
import os
import time
from enum import Enum

from pydantic import BaseModel, Field

from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types


# ── Schema ────────────────────────────────────────────────────────────────────

class Priority(str, Enum):
    urgent = "urgent"
    high = "high"
    medium = "medium"
    low = "low"


class IssueAnalysis(BaseModel):
    """Structured analysis of a project management issue."""
    title: str = Field(description="Brief title summarizing the analysis")
    priority: Priority = Field(description="Recommended priority level")
    summary: str = Field(description="2-3 sentence summary of the issue")
    action_items: list[str] = Field(description="List of recommended next steps")
    estimated_effort: str = Field(description="Estimated effort: small, medium, large")


# ── Tools ─────────────────────────────────────────────────────────────────────

def get_issue_details(issue_id: str) -> dict:
    """Get details about a project issue."""
    return {
        "id": issue_id,
        "title": "Migrate database from PostgreSQL 14 to 17",
        "description": "PostgreSQL 17 has significant performance improvements for our workload. Need to plan and execute the migration with zero downtime.",
        "status": "todo",
        "comments": [
            {"author": "DBA", "content": "pg17 has 2x improvement on our JSONB queries"},
            {"author": "SRE", "content": "We need blue-green deployment for zero downtime"},
            {"author": "PM", "content": "This blocks the Q3 performance milestone"},
        ],
        "dependencies": ["ISS-200: Update ORM to support pg17", "ISS-201: Load testing on pg17"],
    }


# ── Main ──────────────────────────────────────────────────────────────────────

async def main():
    api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GOOGLE_AI_API_KEY")
    if not api_key:
        print("FAIL: GOOGLE_API_KEY not set")
        return False
    os.environ["GOOGLE_API_KEY"] = api_key

    # Note: output_schema + tools may be unstable in some ADK versions.
    # We test both together to validate.
    agent = Agent(
        name="analyst_agent",
        model="gemini-2.5-flash",
        instruction=(
            "You are an issue analyst. When given an issue ID, use get_issue_details to "
            "gather information, then produce a structured analysis. Your final response "
            "MUST follow the output schema exactly."
        ),
        tools=[get_issue_details],
        output_schema=IssueAnalysis,
        output_key="analysis",
    )

    session_service = InMemorySessionService()
    runner = Runner(agent=agent, app_name="spike_06", session_service=session_service)
    session = await session_service.create_session(app_name="spike_06", user_id="test-user")

    prompt = "Analyze issue ISS-150 and provide a structured assessment."

    user_message = types.Content(
        role="user",
        parts=[types.Part.from_text(text=prompt)],
    )

    tool_calls = []
    text_parts = []

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
                    tool_calls.append(part.function_call.name)
                    print(f"  [{elapsed}s] TOOL: {part.function_call.name}")
                elif part.text:
                    text_parts.append(part.text)
                    print(f"  [{elapsed}s] TEXT: {part.text[:100]}...")

    # ── Validation ────────────────────────────────────────────────────────────

    print("\n── Results ──")
    print(f"  Tool calls:   {tool_calls}")
    print(f"  Text parts:   {len(text_parts)}")

    passed = True

    # Check tools were used
    if "get_issue_details" not in tool_calls:
        print("FAIL: get_issue_details tool was not called")
        passed = False
    else:
        print("PASS: Tool was called before producing output")

    # Try to parse the output as IssueAnalysis
    full_text = "\n".join(text_parts)
    print(f"  Raw output:   {full_text[:200]}...")

    # ADK with output_schema may return JSON directly or wrapped
    import json
    try:
        # Try parsing as JSON
        data = json.loads(full_text)
        analysis = IssueAnalysis.model_validate(data)
        print(f"  Parsed title:    {analysis.title}")
        print(f"  Parsed priority: {analysis.priority}")
        print(f"  Parsed summary:  {analysis.summary[:80]}...")
        print(f"  Action items:    {len(analysis.action_items)}")
        print(f"  Effort:          {analysis.estimated_effort}")

        # Validate enum constraint
        if analysis.priority in Priority:
            print("PASS: Priority is a valid enum value")
        else:
            print(f"FAIL: Priority '{analysis.priority}' is not a valid enum value")
            passed = False

        print("PASS: Output validates against Pydantic schema")
    except json.JSONDecodeError:
        print("WARN: Output is not raw JSON — may be markdown-wrapped")
        # Try extracting JSON from markdown code block
        if "```json" in full_text:
            json_str = full_text.split("```json")[1].split("```")[0].strip()
            try:
                data = json.loads(json_str)
                analysis = IssueAnalysis.model_validate(data)
                print("PASS: Extracted and validated JSON from markdown")
            except Exception as e:
                print(f"FAIL: Could not parse extracted JSON: {e}")
                passed = False
        elif "```" in full_text:
            json_str = full_text.split("```")[1].split("```")[0].strip()
            try:
                data = json.loads(json_str)
                analysis = IssueAnalysis.model_validate(data)
                print("PASS: Extracted and validated JSON from code block")
            except Exception as e:
                print(f"FAIL: Could not parse code block: {e}")
                passed = False
        else:
            print("FAIL: Output is not valid JSON and has no code blocks")
            passed = False
    except Exception as e:
        print(f"FAIL: Pydantic validation failed: {e}")
        passed = False

    if passed:
        print("\nPASS: Structured output with tools works")
    else:
        print("\nFAIL: Structured output validation failed")

    return passed


if __name__ == "__main__":
    success = asyncio.run(main())
    exit(0 if success else 1)
