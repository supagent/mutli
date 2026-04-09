import { queryOptions } from "@tanstack/react-query";
import { api } from "@multica/core/api";

export const chatKeys = {
  all: (wsId: string) => ["chat", wsId] as const,
  sessions: (wsId: string) => [...chatKeys.all(wsId), "sessions"] as const,
  allSessions: (wsId: string) => [...chatKeys.all(wsId), "sessions", "all"] as const,
  session: (wsId: string, id: string) => [...chatKeys.all(wsId), "session", id] as const,
  messages: (sessionId: string) => ["chat", "messages", sessionId] as const,
};

export function chatSessionsOptions(wsId: string) {
  return queryOptions({
    queryKey: chatKeys.sessions(wsId),
    queryFn: () => api.listChatSessions(),
    staleTime: Infinity,
  });
}

export function allChatSessionsOptions(wsId: string) {
  return queryOptions({
    queryKey: chatKeys.allSessions(wsId),
    queryFn: () => api.listChatSessions({ status: "all" }),
    staleTime: Infinity,
  });
}

export function chatSessionOptions(wsId: string, id: string) {
  return queryOptions({
    queryKey: chatKeys.session(wsId, id),
    queryFn: () => api.getChatSession(id),
    enabled: !!id,
    staleTime: Infinity,
  });
}

export function chatMessagesOptions(sessionId: string) {
  return queryOptions({
    queryKey: chatKeys.messages(sessionId),
    queryFn: () => api.listChatMessages(sessionId),
    enabled: !!sessionId,
    staleTime: Infinity,
  });
}
