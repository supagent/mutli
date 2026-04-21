"""NDJSON bridge — maps ADK agent events to the daemon's TaskMessagePayload protocol.

Each line emitted to stdout is a JSON object matching the format the Go daemon
expects in executeAndDrain(). The daemon reads these via sandbox PTY or
subprocess stdout and converts them to agent.Message values.

Protocol:
  {"type":"tool_use","seq":1,"tool":"get_issue","input":{...},"task_id":"..."}
  {"type":"tool_result","seq":2,"tool":"get_issue","output":"...","task_id":"..."}
  {"type":"text","seq":3,"content":"...","task_id":"..."}
  {"type":"error","seq":4,"content":"...","task_id":"..."}
  {"type":"result","status":"completed","output":"...","usage":{...},"task_id":"..."}
"""

import json
import sys


# Maximum tool output size (matches daemon's 8KB truncation).
MAX_TOOL_OUTPUT = 8192


class NDJSONEmitter:
    """Emits NDJSON events to stdout for the Go daemon to consume."""

    def __init__(self, task_id: str, issue_id: str = "", model: str = "gemini-2.5-flash"):
        self.task_id = task_id
        self.issue_id = issue_id
        self.model = model
        self.seq = 0
        self.usage: dict = {}

    def _next_seq(self) -> int:
        self.seq += 1
        return self.seq

    def _emit(self, data: dict):
        line = json.dumps(data, separators=(",", ":"))
        sys.stdout.write(line + "\n")
        sys.stdout.flush()

    def _with_agent(self, data: dict, agent_name: str) -> dict:
        """Add agent_name to event data if non-empty (multi-agent attribution)."""
        if agent_name:
            data["agent_name"] = agent_name
        return data

    def emit_tool_use(self, tool: str, args: dict, agent_name: str = "", call_id: str = ""):
        self._emit(self._with_agent({
            "type": "tool_use",
            "seq": self._next_seq(),
            "tool": tool,
            "input": args,
            "task_id": self.task_id,
            "issue_id": self.issue_id,
        }, agent_name))

    def emit_tool_result(self, tool: str, output: str, agent_name: str = "", call_id: str = ""):
        self._emit(self._with_agent({
            "type": "tool_result",
            "seq": self._next_seq(),
            "tool": tool,
            "output": output[:MAX_TOOL_OUTPUT],
            "task_id": self.task_id,
            "issue_id": self.issue_id,
        }, agent_name))

    def emit_text(self, content: str, agent_name: str = ""):
        if content.strip():
            self._emit(self._with_agent({
                "type": "text",
                "seq": self._next_seq(),
                "content": content,
                "task_id": self.task_id,
                "issue_id": self.issue_id,
            }, agent_name))

    def emit_thinking(self, content: str, agent_name: str = ""):
        if content.strip():
            self._emit(self._with_agent({
                "type": "thinking",
                "seq": self._next_seq(),
                "content": content,
                "task_id": self.task_id,
                "issue_id": self.issue_id,
            }, agent_name))

    def emit_error(self, content: str, agent_name: str = ""):
        self._emit(self._with_agent({
            "type": "error",
            "seq": self._next_seq(),
            "content": content,
            "task_id": self.task_id,
            "issue_id": self.issue_id,
        }, agent_name))

    def emit_result(self, status: str, output: str):
        self._emit({
            "type": "result",
            "status": status,
            "output": output,
            "usage": self.usage,
            "task_id": self.task_id,
            "issue_id": self.issue_id,
        })

    def record_usage(self, usage_metadata):
        if not usage_metadata:
            return
        self.usage[self.model] = {
            "input_tokens": getattr(usage_metadata, "prompt_token_count", 0) or 0,
            "output_tokens": getattr(usage_metadata, "candidates_token_count", 0) or 0,
            "cache_read_tokens": getattr(usage_metadata, "cached_content_token_count", 0) or 0,
            "cache_write_tokens": 0,
        }
