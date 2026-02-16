"use client";

import { useState, useCallback } from "react";
import { v7 as uuidv7 } from "uuid";
import {
  type ContentBlock,
  type AgentEvent,
  type StreamPayload,
  type AgentMessageItem,
  type ExecApprovalRequestPayload,
  type ApprovalDecision,
  type CompactionEndEvent,
} from "@multica/sdk";

export type ToolStatus = "running" | "success" | "error" | "interrupted";

export interface CompactionInfo {
  removed: number;
  kept: number;
  tokensRemoved?: number;
  tokensKept?: number;
  reason: string;
}

export type DelegateTaskStatus = "pending" | "running" | "success" | "error" | "timeout";

export interface DelegateTaskProgress {
  index: number;
  label: string;
  status: DelegateTaskStatus;
  startedAtMs?: number;
  durationMs?: number;
  error?: string;
}

export interface DelegateToolProgress {
  kind: "delegate_progress";
  taskCount: number;
  completed: number;
  running: number;
  ok: number;
  errors: number;
  timeouts: number;
  tasks: DelegateTaskProgress[];
  updatedAtMs: number;
}

/** Message source: where did this message come from? */
export type MessageSource =
  | { type: "local" }
  | { type: "gateway"; deviceId: string }
  | { type: "channel"; channelId: string; accountId: string; conversationId: string };

export interface Message {
  id: string;
  role: "user" | "assistant" | "toolResult" | "system";
  content: ContentBlock[];
  agentId: string;
  conversationId?: string;
  stopReason?: string;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolStatus?: ToolStatus;
  toolProgress?: DelegateToolProgress;
  isError?: boolean;
  systemType?: "compaction";
  compaction?: CompactionInfo;
  /** Message source (only for user messages) */
  source?: MessageSource;
}

export interface ChatError {
  code: string;
  message: string;
}

export interface PendingApproval extends ExecApprovalRequestPayload {
  receivedAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toContentBlocks(content: string | ContentBlock[]): ContentBlock[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (Array.isArray(content)) return content;
  return [];
}

function extractContent(event: AgentEvent): ContentBlock[] {
  if (!("message" in event)) return [];
  const msg = event.message;
  if (!msg || !("content" in msg)) return [];
  const content = msg.content;
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

function toTextContentBlock(value: unknown): ContentBlock[] {
  if (value == null) return [];
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
}

function extractToolResultContent(result: unknown): ContentBlock[] {
  if (result == null || typeof result !== "object") return toTextContentBlock(result);
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) return content as ContentBlock[];
  return toTextContentBlock(result);
}

function extractDelegateProgress(partialResult: unknown): DelegateToolProgress | undefined {
  if (!partialResult || typeof partialResult !== "object") return undefined;
  const details = (partialResult as { details?: unknown }).details;
  if (!details || typeof details !== "object") return undefined;
  if ((details as { kind?: unknown }).kind !== "delegate_progress") return undefined;

  const toSafeNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const rawTasks = (details as { tasks?: unknown }).tasks;
  const tasks: DelegateTaskProgress[] = Array.isArray(rawTasks)
    ? rawTasks.flatMap((task, fallbackIndex) => {
        if (!task || typeof task !== "object") return [];
        const status = (task as { status?: unknown }).status;
        if (
          status !== "pending"
          && status !== "running"
          && status !== "success"
          && status !== "error"
          && status !== "timeout"
        ) {
          return [];
        }
        const index = (task as { index?: unknown }).index;
        const label = (task as { label?: unknown }).label;
        const startedAtMs = (task as { startedAtMs?: unknown }).startedAtMs;
        const durationMs = (task as { durationMs?: unknown }).durationMs;
        const error = (task as { error?: unknown }).error;
        return [{
          index: typeof index === "number" && Number.isFinite(index) ? index : fallbackIndex,
          label: typeof label === "string" && label.length > 0 ? label : `Task ${fallbackIndex + 1}`,
          status,
          startedAtMs: typeof startedAtMs === "number" && Number.isFinite(startedAtMs) ? startedAtMs : undefined,
          durationMs: typeof durationMs === "number" && Number.isFinite(durationMs) ? durationMs : undefined,
          error: typeof error === "string" ? error : undefined,
        }];
      })
    : [];

  return {
    kind: "delegate_progress",
    taskCount: toSafeNumber((details as { taskCount?: unknown }).taskCount) || tasks.length,
    completed: toSafeNumber((details as { completed?: unknown }).completed),
    running: toSafeNumber((details as { running?: unknown }).running),
    ok: toSafeNumber((details as { ok?: unknown }).ok),
    errors: toSafeNumber((details as { errors?: unknown }).errors),
    timeouts: toSafeNumber((details as { timeouts?: unknown }).timeouts),
    tasks,
    updatedAtMs: toSafeNumber((details as { updatedAtMs?: unknown }).updatedAtMs) || Date.now(),
  };
}

// ---------------------------------------------------------------------------
// useChat — pure state hook, no IO, no side effects
// ---------------------------------------------------------------------------

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingIds, setStreamingIds] = useState<Set<string>>(new Set());
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [error, setError] = useState<ChatError | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [contextWindowTokens, setContextWindowTokens] = useState<number | undefined>(undefined);

  const isStreaming = streamingIds.size > 0;

  const reset = useCallback(() => {
    setMessages([]);
    setStreamingIds(new Set());
    setPendingApprovals([]);
    setError(null);
    setHasMore(false);
    setContextWindowTokens(undefined);
  }, []);

  /** Convert raw AgentMessageItem[] → Message[] */
  const convertMessages = useCallback((
    raw: AgentMessageItem[],
    agentId: string,
    conversationId = agentId,
  ): Message[] => {
    const toolCallArgsMap = new Map<string, { name: string; args: Record<string, unknown> }>();
    for (const m of raw) {
      if (m.role === "assistant") {
        for (const block of m.content) {
          if (block.type === "toolCall") {
            toolCallArgsMap.set(block.id, { name: block.name, args: block.arguments });
          }
        }
      }
    }

    const loaded: Message[] = [];
    for (const m of raw) {
      if (m.role === "user") {
        loaded.push({
          id: uuidv7(),
          role: "user",
          content: toContentBlocks(m.content),
          agentId,
          conversationId,
          source: m.source,
        });
      } else if (m.role === "assistant") {
        loaded.push({
          id: uuidv7(),
          role: "assistant",
          content: toContentBlocks(m.content),
          agentId,
          conversationId,
          stopReason: m.stopReason,
        });
      } else if (m.role === "toolResult") {
        const callInfo = toolCallArgsMap.get(m.toolCallId);
        loaded.push({
          id: uuidv7(),
          role: "toolResult",
          content: toContentBlocks(m.content),
          agentId,
          conversationId,
          toolCallId: m.toolCallId,
          toolName: m.toolName,
          toolArgs: callInfo?.args,
          toolStatus: m.isError ? "error" : "success",
          isError: m.isError,
        });
      }
    }
    return loaded;
  }, []);

  /** Load initial history (replaces all messages) */
  const setHistory = useCallback((
    raw: AgentMessageItem[],
    agentId: string,
    meta?: { total: number; offset: number; contextWindowTokens?: number },
    conversationId?: string,
  ) => {
    const loaded = convertMessages(raw, agentId, conversationId ?? agentId);
    setMessages(loaded);
    if (meta) {
      setHasMore(meta.offset > 0);
      if (meta.contextWindowTokens !== undefined) {
        setContextWindowTokens(meta.contextWindowTokens);
      }
    }
  }, [convertMessages]);

  /** Prepend older messages (for "load more" pagination) */
  const prependHistory = useCallback((
    raw: AgentMessageItem[],
    agentId: string,
    meta: { total: number; offset: number; contextWindowTokens?: number },
    conversationId?: string,
  ) => {
    const older = convertMessages(raw, agentId, conversationId ?? agentId);
    setMessages((prev) => [...older, ...prev]);
    setHasMore(meta.offset > 0);
    if (meta.contextWindowTokens !== undefined) {
      setContextWindowTokens(meta.contextWindowTokens);
    }
  }, [convertMessages]);

  /** Add a user message */
  const addUserMessage = useCallback((
    text: string,
    agentId: string,
    source?: MessageSource,
    conversationId?: string,
  ) => {
    setMessages((prev) => [
      ...prev,
      {
        id: uuidv7(),
        role: "user",
        content: [{ type: "text", text }],
        agentId,
        conversationId: conversationId ?? agentId,
        source,
      },
    ]);
  }, []);

  /** Process a StreamPayload → update messages + streamingIds */
  const handleStream = useCallback((payload: StreamPayload) => {
    const { event } = payload;
    const sessionId = payload.sessionId ?? payload.conversationId ?? payload.agentId;

    switch (event.type) {
      case "message_start": {
        const newMsg: Message = {
          id: payload.streamId,
          role: "assistant",
          content: [],
          agentId: payload.agentId,
          conversationId: sessionId,
        };
        const content = extractContent(event);
        if (content.length) newMsg.content = content;

        setMessages((prev) => [...prev, newMsg]);
        setStreamingIds((prev) => new Set(prev).add(payload.streamId));
        break;
      }
      case "message_update": {
        const content = extractContent(event);
        setMessages((prev) =>
          prev.map((m) => (m.id === payload.streamId ? { ...m, content } : m)),
        );
        break;
      }
      case "message_end": {
        const content = extractContent(event);
        const stopReason =
          "message" in event
            ? (event.message as { stopReason?: string })?.stopReason
            : undefined;

        setMessages((prev) =>
          prev.map((m) => {
            if (m.id === payload.streamId) return { ...m, content, stopReason };
            if (
              m.role === "toolResult"
              && m.toolStatus === "running"
              && m.agentId === payload.agentId
              && (m.conversationId ?? m.agentId) === sessionId
            ) {
              return { ...m, toolStatus: "interrupted" as ToolStatus };
            }
            return m;
          }),
        );
        setStreamingIds((prev) => {
          const next = new Set(prev);
          next.delete(payload.streamId);
          return next;
        });
        break;
      }
      case "tool_execution_start": {
        setMessages((prev) => [
          ...prev,
          {
            id: uuidv7(),
            role: "toolResult",
            content: [],
            agentId: payload.agentId,
            conversationId: sessionId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            toolArgs: event.args as Record<string, unknown> | undefined,
            toolStatus: "running",
            isError: false,
          },
        ]);
        break;
      }
      case "tool_execution_end": {
        setMessages((prev) =>
          prev.map((m) =>
            m.role === "toolResult" && m.toolCallId === event.toolCallId
              ? {
                  ...m,
                  toolStatus: (event.isError ? "error" : "success") as ToolStatus,
                  isError: event.isError ?? false,
                  content: extractToolResultContent(event.result),
                }
              : m,
          ),
        );
        break;
      }
      case "tool_execution_update": {
        const partialContent = extractToolResultContent(event.partialResult);
        const delegateProgress = event.toolName === "delegate"
          ? extractDelegateProgress(event.partialResult)
          : undefined;

        setMessages((prev) =>
          prev.map((m) =>
            m.role === "toolResult" && m.toolCallId === event.toolCallId
              ? {
                  ...m,
                  content: partialContent.length > 0 ? partialContent : m.content,
                  toolProgress: delegateProgress ?? m.toolProgress,
                }
              : m,
          ),
        );
        break;
      }
      case "compaction_end": {
        const ce = event as CompactionEndEvent;
        setMessages((prev) => [
          ...prev,
          {
            id: uuidv7(),
            role: "system",
            content: [],
            agentId: payload.agentId,
            conversationId: sessionId,
            systemType: "compaction",
            compaction: {
              removed: ce.removed,
              kept: ce.kept,
              tokensRemoved: ce.tokensRemoved,
              tokensKept: ce.tokensKept,
              reason: ce.reason,
            },
          },
        ]);
        break;
      }
    }
  }, []);

  /** Add pending approval */
  const addApproval = useCallback((payload: ExecApprovalRequestPayload) => {
    setPendingApprovals((prev) => [...prev, { ...payload, receivedAt: Date.now() }]);
  }, []);

  /** Remove pending approval */
  const removeApproval = useCallback((approvalId: string) => {
    setPendingApprovals((prev) => prev.filter((a) => a.approvalId !== approvalId));
  }, []);

  return {
    // Rendering state
    messages,
    streamingIds,
    isStreaming,
    hasMore,
    contextWindowTokens,
    pendingApprovals,
    error,
    // State control (for transport layer to call)
    setError,
    reset,
    setHistory,
    prependHistory,
    addUserMessage,
    handleStream,
    addApproval,
    removeApproval,
  };
}

export type UseChatReturn = ReturnType<typeof useChat>;
