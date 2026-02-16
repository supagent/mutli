/** RPC Actions - 请求/响应模式 */

import type { Message } from "@mariozechner/pi-ai";

export const RequestAction = "request" as const;
export const ResponseAction = "response" as const;

/** 请求帧 payload */
export interface RequestPayload<T = unknown> {
  /** 请求 ID，由客户端生成，服务端原样回传到 ResponsePayload.requestId */
  requestId: string;
  /** 调用的方法名 */
  method: string;
  /** 方法参数 */
  params?: T;
}

/** 响应帧 payload - 成功 */
export interface ResponseSuccessPayload<T = unknown> {
  /** 与请求消息 ID 匹配 */
  requestId: string;
  /** 是否成功 */
  ok: true;
  /** 返回数据 */
  payload: T;
}

/** 响应帧 payload - 失败 */
export interface ResponseErrorPayload {
  /** 与请求消息 ID 匹配 */
  requestId: string;
  /** 是否成功 */
  ok: false;
  /** 错误信息 */
  error: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}

/** 响应帧 payload（联合类型） */
export type ResponsePayload<T = unknown> =
  | ResponseSuccessPayload<T>
  | ResponseErrorPayload;

/** 类型守卫：判断响应是否成功 */
export function isResponseSuccess<T>(
  response: ResponsePayload<T>
): response is ResponseSuccessPayload<T> {
  return response.ok === true;
}

/** 类型守卫：判断响应是否失败 */
export function isResponseError(
  response: ResponsePayload
): response is ResponseErrorPayload {
  return response.ok === false;
}

// ============ RPC Method Types ============

/** Default number of messages returned per page */
export const DEFAULT_MESSAGES_LIMIT = 200;

/** getAgentMessages - request params */
export interface GetAgentMessagesParams {
  agentId: string;
  /** Optional conversation ID. Falls back to agent main conversation when omitted. */
  conversationId?: string;
  offset?: number;
  limit?: number;
}

/**
 * Agent message returned by getAgentMessages.
 * This is pi-ai's Message type — the backend returns it as-is from SessionManager.loadMessages().
 */
export type AgentMessageItem = Message;

/** getAgentMessages - response payload */
export interface GetAgentMessagesResult {
  messages: AgentMessageItem[];
  total: number;
  offset: number;
  limit: number;
  /** Resolved conversation ID used by the server */
  conversationId?: string;
  /** Context window size (tokens) used by this session */
  contextWindowTokens?: number;
}

/** getHubInfo - no params needed */
export interface GetHubInfoResult {
  hubId: string;
  url: string;
  connectionState: string;
  agentCount: number;
}

/** listAgents - no params needed */
export interface ListAgentsResult {
  agents: { id: string; closed: boolean }[];
}

/** listConversations - no params needed (conversation-first alias of listAgents) */
export interface ListConversationsResult {
  conversations: { id: string; closed: boolean }[];
}

/** createAgent - request params */
export interface CreateAgentParams {
  id?: string;
}

/** createAgent - response payload */
export interface CreateAgentResult {
  id: string;
}

/** createConversation - request params (create a conversation, optionally under a specific agent) */
export interface CreateConversationParams {
  id?: string;
  agentId?: string;
}

/** createConversation - response payload */
export interface CreateConversationResult {
  id: string;
}

/** deleteAgent - request params */
export interface DeleteAgentParams {
  id: string;
}

/** deleteAgent - response payload */
export interface DeleteAgentResult {
  ok: boolean;
}

/** deleteConversation - request params (conversation-first alias of deleteAgent) */
export interface DeleteConversationParams {
  id: string;
}

/** deleteConversation - response payload */
export interface DeleteConversationResult {
  ok: boolean;
}

/** updateGateway - request params */
export interface UpdateGatewayParams {
  url: string;
}

/** updateGateway - response payload */
export interface UpdateGatewayResult {
  url: string;
  connectionState: string;
}

/** Device metadata collected during verify handshake */
export interface DeviceMeta {
  userAgent?: string;
  platform?: string;
  language?: string;
}

/** verify - request params */
export interface VerifyParams {
  token?: string;
  meta?: DeviceMeta;
}

/** verify - response payload */
export interface VerifyResult {
  hubId: string;
  agentId: string;
  /** Authorized conversation scope for this device. */
  conversationId?: string;
  /** Session ID alias (same value as conversationId). */
  sessionId?: string;
  /** Backward-compatible alias for conversationId. */
  mainConversationId?: string;
}
