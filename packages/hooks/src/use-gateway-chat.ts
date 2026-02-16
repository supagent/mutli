"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  type GatewayClient,
  type StreamPayload,
  type GetAgentMessagesResult,
  type ExecApprovalRequestPayload,
  type ApprovalDecision,
  DEFAULT_MESSAGES_LIMIT,
  StreamAction,
  ExecApprovalRequestAction,
} from "@multica/sdk";
import { useChat } from "./use-chat";

interface UseGatewayChatOptions {
  client: GatewayClient;
  hubId: string;
  agentId: string;
  conversationId?: string;
}

export function useGatewayChat({ client, hubId, agentId, conversationId }: UseGatewayChatOptions) {
  const chat = useChat();
  const resolvedConversationId = conversationId ?? agentId;
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const isLoadingMoreRef = useRef(false);
  const offsetRef = useRef<number | null>(null);

  // Fetch latest messages on mount
  useEffect(() => {
    client
      .request<GetAgentMessagesResult>(hubId, "getAgentMessages", {
        agentId,
        conversationId: resolvedConversationId,
        limit: DEFAULT_MESSAGES_LIMIT,
      })
      .then((result) => {
        chat.setHistory(result.messages, agentId, {
          total: result.total,
          offset: result.offset,
          contextWindowTokens: result.contextWindowTokens,
        }, result.conversationId ?? resolvedConversationId);
        offsetRef.current = result.offset;
      })
      .catch(() => {})
      .finally(() => setIsLoadingHistory(false));
  }, [client, hubId, agentId, resolvedConversationId]);

  // Subscribe to events
  useEffect(() => {
    client.onMessage((msg) => {
      if (msg.action === StreamAction) {
        const payload = msg.payload as StreamPayload;
        const payloadConversationId = payload.sessionId ?? payload.conversationId ?? payload.agentId;
        if (payload.agentId !== agentId || payloadConversationId !== resolvedConversationId) {
          return;
        }
        if (payload.event.type === "agent_error") {
          const errorMsg = (payload.event as { message?: string }).message ?? "Unknown error";
          chat.setError({ code: "AGENT_ERROR", message: errorMsg });
          setIsLoading(false);
          return;
        }
        chat.handleStream(payload);
        if (payload.event.type === "message_start") setIsLoading(true);
        if (payload.event.type === "message_end") setIsLoading(false);
        return;
      }
      if (msg.action === ExecApprovalRequestAction) {
        const approval = msg.payload as ExecApprovalRequestPayload;
        const approvalConversationId = approval.sessionId ?? approval.conversationId ?? approval.agentId;
        if (approval.agentId !== agentId || approvalConversationId !== resolvedConversationId) {
          return;
        }
        chat.addApproval(approval);
        return;
      }
      if (msg.action === "error") {
        chat.setError(msg.payload as { code: string; message: string });
        return;
      }
    });
    return () => { client.onMessage(() => {}); };
  }, [client, agentId, resolvedConversationId]);

  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      chat.addUserMessage(trimmed, agentId, { type: "local" }, resolvedConversationId);
      chat.setError(null);
      client.send(hubId, "message", {
        agentId,
        conversationId: resolvedConversationId,
        sessionId: resolvedConversationId,
        content: trimmed,
      });
      setIsLoading(true);
    },
    [client, hubId, agentId, resolvedConversationId],
  );

  const loadMore = useCallback(async () => {
    const currentOffset = offsetRef.current;
    if (currentOffset == null || currentOffset <= 0 || isLoadingMoreRef.current) return;

    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);
    try {
      const newOffset = Math.max(0, currentOffset - DEFAULT_MESSAGES_LIMIT);
      const limit = currentOffset - newOffset;
      const result = await client.request<GetAgentMessagesResult>(
        hubId, "getAgentMessages", { agentId, conversationId: resolvedConversationId, offset: newOffset, limit },
      );
      chat.prependHistory(result.messages, agentId, {
        total: result.total,
        offset: result.offset,
        contextWindowTokens: result.contextWindowTokens,
      }, result.conversationId ?? resolvedConversationId);
      offsetRef.current = result.offset;
    } catch {
      // Best-effort — pagination failure does not block chat
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [client, hubId, agentId, resolvedConversationId]);

  const resolveApproval = useCallback(
    (approvalId: string, decision: ApprovalDecision) => {
      chat.removeApproval(approvalId);
      client.request(hubId, "resolveExecApproval", { approvalId, decision }).catch(() => {});
    },
    [client, hubId],
  );

  return {
    messages: chat.messages,
    streamingIds: chat.streamingIds,
    isLoading,
    isLoadingHistory,
    isLoadingMore,
    hasMore: chat.hasMore,
    contextWindowTokens: chat.contextWindowTokens,
    error: chat.error,
    pendingApprovals: chat.pendingApprovals,
    sendMessage,
    loadMore,
    resolveApproval,
  };
}
