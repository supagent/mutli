/**
 * Messages Store - manages chat messages and streaming state
 *
 * Data model mirrors the backend (pi-ai / pi-agent-core) exactly:
 *   - UserMessage:       { role: "user",       content: ContentBlock[] }
 *   - AssistantMessage:  { role: "assistant",  content: ContentBlock[] }
 *   - ToolResultMessage: { role: "toolResult", toolCallId, toolName, content, isError }
 *
 * Streaming simply updates the content of the current assistant message in-place.
 * Tool execution events (start/end) create / update toolResult messages.
 */
import { create } from "zustand"
import { v7 as uuidv7 } from "uuid"
import type { ContentBlock } from "@multica/sdk"

export type ToolStatus = "running" | "success" | "error" | "interrupted"

export interface CompactionStats {
  removed: number
  kept: number
  tokensRemoved?: number
  tokensKept?: number
  reason: string
}

export interface Message {
  id: string
  role: "user" | "assistant" | "toolResult"
  content: ContentBlock[]
  agentId: string
  // AssistantMessage metadata
  stopReason?: string
  // ToolResult fields (only when role === "toolResult")
  toolCallId?: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolStatus?: ToolStatus
  isError?: boolean
}

/** Parameters needed to route a message through the gateway */
export interface SendContext {
  hubId: string
  agentId: string
  send: (to: string, action: string, payload: unknown) => void
}

interface MessagesState {
  messages: Message[]
  streamingIds: Set<string>
  compacting: boolean
  lastCompaction: CompactionStats | null
}

interface MessagesActions {
  sendMessage: (text: string, ctx: SendContext) => void
  addUserMessage: (content: string, agentId: string) => void
  addAssistantMessage: (content: string, agentId: string) => void
  updateMessage: (id: string, content: ContentBlock[]) => void
  loadMessages: (msgs: Message[]) => void
  clearMessages: () => void
  // Streaming
  startStream: (streamId: string, agentId: string) => void
  appendStream: (streamId: string, content: ContentBlock[]) => void
  endStream: (streamId: string, content: ContentBlock[], stopReason?: string) => void
  // Tool execution lifecycle
  startToolExecution: (agentId: string, toolCallId: string, toolName: string, args?: unknown) => void
  endToolExecution: (toolCallId: string, result?: unknown, isError?: boolean) => void
  // Compaction lifecycle
  startCompaction: () => void
  endCompaction: (stats: CompactionStats) => void
}

export type MessagesStore = MessagesState & MessagesActions

export const useMessagesStore = create<MessagesStore>()((set, get) => ({
  messages: [],
  streamingIds: new Set<string>(),
  compacting: false,
  lastCompaction: null,

  sendMessage: (text, ctx) => {
    get().addUserMessage(text, ctx.agentId)
    ctx.send(ctx.hubId, "message", { agentId: ctx.agentId, content: text })
  },

  addUserMessage: (content, agentId) => {
    set((s) => ({
      messages: [...s.messages, {
        id: uuidv7(),
        role: "user",
        content: [{ type: "text" as const, text: content }],
        agentId,
      }],
    }))
  },

  addAssistantMessage: (content, agentId) => {
    set((s) => ({
      messages: [...s.messages, {
        id: uuidv7(),
        role: "assistant",
        content: [{ type: "text" as const, text: content }],
        agentId,
      }],
    }))
  },

  updateMessage: (id, content) => {
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, content } : m)),
    }))
  },

  loadMessages: (msgs) => {
    set({ messages: msgs })
  },

  clearMessages: () => {
    set({ messages: [], streamingIds: new Set(), compacting: false, lastCompaction: null })
  },

  // --- Streaming: build assistant message incrementally ---

  startStream: (streamId, agentId) => {
    set((s) => {
      const ids = new Set(s.streamingIds)
      ids.add(streamId)
      return {
        messages: [...s.messages, { id: streamId, role: "assistant" as const, content: [], agentId }],
        streamingIds: ids,
      }
    })
  },

  // Replace the entire content array with the latest partial snapshot
  appendStream: (streamId, content) => {
    set((s) => ({
      messages: s.messages.map((m) => (m.id === streamId ? { ...m, content } : m)),
    }))
  },

  endStream: (streamId, content, stopReason) => {
    set((s) => {
      const ids = new Set(s.streamingIds)
      ids.delete(streamId)
      // Find the agentId of the stream being ended to scope tool interruption
      const streamMsg = s.messages.find((m) => m.id === streamId)
      const streamAgentId = streamMsg?.agentId
      return {
        messages: s.messages.map((m) => {
          if (m.id === streamId) return { ...m, content, stopReason }
          // Interrupt running tool executions belonging to the same agent
          if (m.role === "toolResult" && m.toolStatus === "running" && m.agentId === streamAgentId) {
            return { ...m, toolStatus: "interrupted" as ToolStatus }
          }
          return m
        }),
        streamingIds: ids,
      }
    })
  },

  // --- Tool execution: create / update toolResult messages ---

  startToolExecution: (agentId, toolCallId, toolName, args) => {
    set((s) => ({
      messages: [...s.messages, {
        id: uuidv7(),
        role: "toolResult" as const,
        content: [],
        agentId,
        toolCallId,
        toolName,
        toolArgs: args as Record<string, unknown> | undefined,
        toolStatus: "running" as ToolStatus,
        isError: false,
      }],
    }))
  },

  endToolExecution: (toolCallId, result, isError) => {
    set((s) => ({
      messages: s.messages.map((m) =>
        m.role === "toolResult" && m.toolCallId === toolCallId
          ? {
              ...m,
              toolStatus: (isError ? "error" : "success") as ToolStatus,
              isError: isError ?? false,
              content: result != null
                ? [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result) }]
                : [],
            }
          : m
      ),
    }))
  },

  // --- Compaction lifecycle ---

  startCompaction: () => {
    set({ compacting: true })
  },

  endCompaction: (stats) => {
    set({ compacting: false, lastCompaction: stats })
  },
}))
