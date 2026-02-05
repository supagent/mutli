/**
 * Super Multica custom events (parallel to pi-agent-core's AgentEvent)
 *
 * These events extend the agent's event system with Multica-specific
 * lifecycle events that pi-agent-core does not provide.
 */

/** Emitted when context compaction begins */
export type CompactionStartEvent = {
  type: "compaction_start";
};

/**
 * Emitted when context compaction completes.
 *
 * Note: `reason` uses a narrow union here for type safety within the agent.
 * The SDK's `CompactionEndEvent` uses `string` to allow future extensions
 * without requiring SDK version bumps.
 */
export type CompactionEndEvent = {
  type: "compaction_end";
  removed: number;
  kept: number;
  tokensRemoved?: number;
  tokensKept?: number;
  reason: "count" | "tokens" | "summary";
};

/** Union of all Multica-specific events */
export type MulticaEvent = CompactionStartEvent | CompactionEndEvent;
