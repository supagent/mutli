/**
 * Hook for local direct chat with agent via IPC (no Gateway required).
 *
 * This hook bridges IPC events to useMessagesStore, allowing the Chat component
 * to work identically in both local IPC and remote Gateway modes.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { useMessagesStore } from '@multica/store'
import type { ContentBlock, CompactionEndEvent } from '@multica/sdk'

interface UseLocalChatOptions {
  agentId: string
}

interface UseLocalChatReturn {
  isConnected: boolean
  isLoading: boolean
  sendMessage: (content: string) => void
  disconnect: () => void
}

/**
 * Provides local IPC chat that uses the same useMessagesStore as Gateway mode.
 * This enables full Chat component reuse.
 */
export function useLocalChat({ agentId }: UseLocalChatOptions): UseLocalChatReturn {
  const [isConnected, setIsConnected] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const currentStreamRef = useRef<string | null>(null)

  // Subscribe to agent events on mount
  useEffect(() => {
    if (!agentId) return

    const subscribe = async () => {
      const result = await window.electronAPI.localChat.subscribe(agentId)
      if (result.ok) {
        setIsConnected(true)
      }
    }

    subscribe()

    // Load message history from agent session
    const loadHistory = async () => {
      try {
        const result = await window.electronAPI.localChat.getHistory(agentId)
        if (result.messages && result.messages.length > 0) {
          // Normalize: IPC may return content as string, store expects ContentBlock[]
          useMessagesStore.getState().loadMessages(
            result.messages.map((m: Record<string, unknown>) => ({
              ...m,
              content: typeof m.content === 'string'
                ? (m.content ? [{ type: 'text' as const, text: m.content }] : [])
                : (m.content ?? []),
            })) as import('@multica/store').Message[]
          )
        }
      } catch {
        // History load is best-effort
      }
    }
    loadHistory()

    // Listen for events and route to useMessagesStore
    window.electronAPI.localChat.onEvent((event) => {
      if (event.agentId !== agentId) return

      const store = useMessagesStore.getState()

      // Handle error
      if (event.type === 'error') {
        store.addAssistantMessage(event.content ?? 'Unknown error', agentId)
        setIsLoading(false)
        return
      }

      // Handle agent events - same logic as connection-store.ts
      const agentEvent = event.event
      const streamId = event.streamId
      if (!agentEvent) return

      // Handle compaction events (no streamId required)
      if (agentEvent.type === 'compaction_start') {
        store.startCompaction()
        return
      }
      if (agentEvent.type === 'compaction_end') {
        const evt = agentEvent as CompactionEndEvent
        store.endCompaction({
          removed: evt.removed,
          kept: evt.kept,
          tokensRemoved: evt.tokensRemoved,
          tokensKept: evt.tokensKept,
          reason: evt.reason,
        })
        return
      }

      if (!streamId) return

      if (agentEvent.type === 'message_start') {
        currentStreamRef.current = streamId
        store.startStream(streamId, agentId)
        const content = extractContentFromAgentEvent(agentEvent)
        if (content.length) store.appendStream(streamId, content)
      } else if (agentEvent.type === 'message_update') {
        const content = extractContentFromAgentEvent(agentEvent)
        if (content.length && currentStreamRef.current) {
          store.appendStream(currentStreamRef.current, content)
        }
      } else if (agentEvent.type === 'message_end') {
        const content = extractContentFromAgentEvent(agentEvent)
        if (currentStreamRef.current) {
          store.endStream(currentStreamRef.current, content)
          currentStreamRef.current = null
        }
        setIsLoading(false)
      }
    })

    return () => {
      window.electronAPI.localChat.offEvent()
      window.electronAPI.localChat.unsubscribe(agentId)
      setIsConnected(false)
    }
  }, [agentId])

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || !agentId || isLoading) return

      // Add user message to store (same as Gateway mode)
      useMessagesStore.getState().addUserMessage(content.trim(), agentId)
      setIsLoading(true)

      // Send via IPC
      const result = await window.electronAPI.localChat.send(agentId, content.trim())
      if (result.error) {
        useMessagesStore.getState().addAssistantMessage(`Error: ${result.error}`, agentId)
        setIsLoading(false)
      }
    },
    [agentId, isLoading]
  )

  const disconnect = useCallback(() => {
    useMessagesStore.getState().clearMessages()
    setIsConnected(false)
    setIsLoading(false)
  }, [])

  return {
    isConnected,
    isLoading,
    sendMessage,
    disconnect,
  }
}

/** Extract content blocks from AgentEvent message */
function extractContentFromAgentEvent(event: { message?: { content?: unknown } }): ContentBlock[] {
  if (!event.message?.content) return []
  const content = event.message.content
  return Array.isArray(content) ? content as ContentBlock[] : []
}
