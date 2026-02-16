import { useState, useEffect, useCallback, useRef } from 'react'
import { useChat, type MessageSource } from '@multica/hooks/use-chat'
import type {
  StreamPayload,
  ExecApprovalRequestPayload,
  ApprovalDecision,
  AgentMessageItem,
  AgentErrorEvent,
} from '@multica/sdk'
import { DEFAULT_MESSAGES_LIMIT } from '@multica/sdk'

export interface QueuedLocalMessage {
  id: string
  text: string
  createdAt: number
}

interface UseLocalChatOptions {
  conversationId?: string
}

function makeQueueId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `queued-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function useLocalChat(options: UseLocalChatOptions = {}) {
  const requestedConversationId = options.conversationId
  const chat = useChat()
  const chatRef = useRef(chat)
  chatRef.current = chat
  const [agentId, setAgentId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const isLoadingRef = useRef(false)
  const [isLoadingHistory, setIsLoadingHistory] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const isLoadingMoreRef = useRef(false)
  const [queuedMessages, setQueuedMessages] = useState<QueuedLocalMessage[]>([])
  const [initError, setInitError] = useState<string | null>(null)
  const initRef = useRef(false)
  const offsetRef = useRef<number | null>(null)
  const activeConversationId = requestedConversationId ?? agentId

  // Initialize hub and get default agent ID
  useEffect(() => {
    if (initRef.current) return
    initRef.current = true

    window.electronAPI.hub.init()
      .then((result) => {
        const r = result as { defaultAgentId?: string; defaultConversationId?: string }
        const defaultConversationId = r.defaultConversationId ?? r.defaultAgentId
        console.log('[LocalChat] hub.init → defaultConversationId:', defaultConversationId)
        if (defaultConversationId) {
          setAgentId(defaultConversationId)
        } else if (requestedConversationId) {
          setAgentId(requestedConversationId)
        } else {
          setInitError('No default agent available')
          setIsLoadingHistory(false)
        }
      })
      .catch((err: Error) => {
        setInitError(err.message)
        setIsLoadingHistory(false)
      })
  }, [requestedConversationId])

  // Subscribe to events + fetch history once conversation is available
  useEffect(() => {
    if (!activeConversationId) return
    const resolvedAgentId = agentId ?? activeConversationId
    setQueuedMessages([])
    offsetRef.current = null
    setIsLoading(false)
    setIsLoadingHistory(true)
    chatRef.current.reset()

    // Subscribe to agent events
    window.electronAPI.localChat.subscribe(activeConversationId).catch(() => {})

    // Listen for stream events
    window.electronAPI.localChat.onEvent((data) => {
      // Cast IPC event to StreamPayload (same shape: { agentId, streamId, event })
      const payload = data as unknown as StreamPayload
      if (!payload.event) return

      // Handle agent error events
      if (payload.event.type === 'agent_error') {
        const errorEvent = payload.event as AgentErrorEvent
        chatRef.current.setError({ code: 'AGENT_ERROR', message: errorEvent.message })
        setIsLoading(false)
        return
      }

      chatRef.current.handleStream(payload)
      if (payload.event.type === 'message_start') setIsLoading(true)
      if (payload.event.type === 'tool_execution_start') setIsLoading(true)
      if (payload.event.type === 'message_end') {
        const stopReason =
          'message' in payload.event
            ? (payload.event.message as { stopReason?: string } | undefined)?.stopReason
            : undefined

        // message_end with stopReason=toolUse is an intermediate step in the same run.
        // Keep loading=true so queued user messages are not dispatched mid-run.
        if (stopReason === 'toolUse') {
          setIsLoading(true)
        } else {
          setIsLoading(false)
        }
      }
    })

    // Listen for exec approval requests
    window.electronAPI.localChat.onApproval((approval) => {
      chatRef.current.addApproval(approval as ExecApprovalRequestPayload)
    })

    // Listen for inbound messages from all sources (gateway, channel)
    // This allows the local UI to display messages from other sources
    window.electronAPI.hub.onInboundMessage((event: InboundMessageEvent) => {
      const eventConversationId = event.conversationId
      // Only add non-local messages (local messages are added by sendMessage)
      if (event.source.type !== 'local' && eventConversationId === activeConversationId) {
        chatRef.current.addUserMessage(
          event.content,
          event.agentId,
          event.source as MessageSource,
          eventConversationId,
        )
        setIsLoading(true)
      }
    })

    // Fetch history with pagination
    window.electronAPI.localChat.getHistory(resolvedAgentId, {
      limit: DEFAULT_MESSAGES_LIMIT,
      conversationId: activeConversationId,
    })
      .then((result) => {
        console.log('[LocalChat] getHistory result:', result.messages?.length, 'messages, total:', result.total)
        if (result.messages?.length) {
          chatRef.current.setHistory(result.messages as AgentMessageItem[], resolvedAgentId, {
            total: result.total,
            offset: result.offset,
            contextWindowTokens: result.contextWindowTokens,
          }, activeConversationId)
          offsetRef.current = result.offset
        } else {
          chatRef.current.setHistory([], resolvedAgentId, {
            total: 0,
            offset: 0,
            contextWindowTokens: result.contextWindowTokens,
          }, activeConversationId)
        }
      })
      .catch(() => {})
      .finally(() => setIsLoadingHistory(false))

    return () => {
      window.electronAPI.localChat.offEvent()
      window.electronAPI.localChat.offApproval()
      window.electronAPI.hub.offInboundMessage()
      window.electronAPI.localChat.unsubscribe(activeConversationId).catch(() => {})
    }
  }, [agentId, activeConversationId])

  useEffect(() => {
    isLoadingRef.current = isLoading
  }, [isLoading])

  const dispatchMessageNow = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed || !activeConversationId) return
    const resolvedAgentId = agentId ?? activeConversationId
    chatRef.current.addUserMessage(trimmed, resolvedAgentId, { type: 'local' }, activeConversationId)
    chatRef.current.setError(null)
    setIsLoading(true)
    window.electronAPI.localChat.send(resolvedAgentId, trimmed, activeConversationId)
      .then((result) => {
        const response = result as { ok?: boolean; error?: string } | undefined
        if (response?.error) {
          setIsLoading(false)
        }
      })
      .catch(() => {
        setIsLoading(false)
      })
  }, [agentId, activeConversationId])

  const sendMessage = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed || !activeConversationId) return

    if (isLoadingRef.current) {
      setQueuedMessages((prev) => [
        ...prev,
        {
          id: makeQueueId(),
          text: trimmed,
          createdAt: Date.now(),
        },
      ])
      return
    }

    dispatchMessageNow(trimmed)
  }, [activeConversationId, dispatchMessageNow])

  const removeQueuedMessage = useCallback((id: string) => {
    setQueuedMessages((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const clearQueuedMessages = useCallback(() => {
    setQueuedMessages([])
  }, [])

  useEffect(() => {
    if (!activeConversationId || isLoading || queuedMessages.length === 0) return
    const next = queuedMessages[0]
    if (!next) return
    setQueuedMessages((prev) => prev.slice(1))
    dispatchMessageNow(next.text)
  }, [activeConversationId, isLoading, queuedMessages, dispatchMessageNow])

  const abortGeneration = useCallback(() => {
    if (!activeConversationId) return
    const resolvedAgentId = agentId ?? activeConversationId
    window.electronAPI.localChat.abort(resolvedAgentId, activeConversationId).catch(() => {})
    setIsLoading(false)
  }, [agentId, activeConversationId])

  const loadMore = useCallback(async () => {
    const currentOffset = offsetRef.current
    if (!activeConversationId || currentOffset == null || currentOffset <= 0 || isLoadingMoreRef.current) return

    isLoadingMoreRef.current = true
    setIsLoadingMore(true)
    try {
      const resolvedAgentId = agentId ?? activeConversationId
      const newOffset = Math.max(0, currentOffset - DEFAULT_MESSAGES_LIMIT)
      const limit = currentOffset - newOffset
      const result = await window.electronAPI.localChat.getHistory(resolvedAgentId, {
        offset: newOffset,
        limit,
        conversationId: activeConversationId,
      })
      if (result.messages?.length) {
        chatRef.current.prependHistory(result.messages as AgentMessageItem[], resolvedAgentId, {
          total: result.total,
          offset: result.offset,
          contextWindowTokens: result.contextWindowTokens,
        }, activeConversationId)
        offsetRef.current = result.offset
      }
    } catch {
      // Best-effort — pagination failure does not block chat
    } finally {
      isLoadingMoreRef.current = false
      setIsLoadingMore(false)
    }
  }, [agentId, activeConversationId])

  const resolveApproval = useCallback(
    (approvalId: string, decision: ApprovalDecision) => {
      chatRef.current.removeApproval(approvalId)
      window.electronAPI.localChat.resolveExecApproval(approvalId, decision).catch(() => {})
    },
    [],
  )

  const clearError = useCallback(() => {
    chatRef.current.setError(null)
  }, [])

  return {
    agentId,
    conversationId: activeConversationId,
    initError,
    messages: chat.messages,
    streamingIds: chat.streamingIds,
    isLoading,
    isLoadingHistory,
    isLoadingMore,
    hasMore: chat.hasMore,
    contextWindowTokens: chat.contextWindowTokens,
    error: chat.error,
    pendingApprovals: chat.pendingApprovals,
    queuedMessages,
    sendMessage,
    abortGeneration,
    removeQueuedMessage,
    clearQueuedMessages,
    loadMore,
    resolveApproval,
    clearError,
  }
}
