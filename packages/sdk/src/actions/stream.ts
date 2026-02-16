/** Stream Action */

export const StreamAction = "stream" as const;

// --- Content block types (re-exported from pi-ai, the single source of truth) ---

import type {
  TextContent,
  ThinkingContent,
  ToolCall,
  ImageContent,
} from "@mariozechner/pi-ai";
import type { AgentEvent } from "@mariozechner/pi-agent-core";

export type { TextContent, ThinkingContent, ToolCall, ImageContent };
export type { AgentEvent };

/**
 * Convenience union of all content block types across message roles.
 *
 * NOTE: This is a deliberate simplification. The backend uses narrower unions
 * per role (e.g. AssistantMessage.content excludes ImageContent, UserMessage
 * excludes ThinkingContent/ToolCall). We accept the wider union on the frontend
 * for simpler handling — the backend already guarantees correctness.
 */
export type ContentBlock = TextContent | ThinkingContent | ToolCall | ImageContent;

// --- Compaction event types (Multica-specific, not from pi-agent-core) ---

/** Emitted when context compaction begins */
export type CompactionStartEvent = {
  type: "compaction_start";
};

/** Emitted when context compaction completes */
export type CompactionEndEvent = {
  type: "compaction_end";
  removed: number;
  kept: number;
  tokensRemoved?: number;
  tokensKept?: number;
  reason: string;
  /** Tool result pruning statistics (when Phase 1 pruning was applied) */
  pruningStats?: { softTrimmed: number; hardCleared: number; charsSaved: number };
};

/** Union of all compaction events */
export type CompactionEvent = CompactionStartEvent | CompactionEndEvent;

/** Emitted when an agent encounters an error during execution */
export type AgentErrorEvent = {
  type: "agent_error";
  message: string;
};

// --- Stream event types ---

/**
 * Hub forwards AgentEvent from pi-agent-core, CompactionEvent, and AgentErrorEvent as-is.
 * StreamPayload wraps them with routing metadata.
 */
export interface StreamPayload {
  streamId: string;
  agentId: string;
  /** Conversation ID of this stream event. */
  conversationId: string;
  /** Session ID alias (same value as conversationId). */
  sessionId?: string;
  event: AgentEvent | CompactionEvent | AgentErrorEvent;
}

/** Extract thinking/reasoning content from an AgentEvent that carries a message */
export function extractThinkingFromEvent(event: AgentEvent): string {
  if (!("message" in event)) return "";
  const msg = event.message;
  if (!msg || !("content" in msg)) return "";
  const content = msg.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is ThinkingContent => c.type === "thinking")
    .map((c) => c.thinking ?? "")
    .join("");
}
