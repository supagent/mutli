import type { QueryClient } from "@tanstack/react-query";
import type { ChatMessage } from "@multica/core/types";
import { chatKeys } from "./queries";

export function onChatMessageCreated(
  qc: QueryClient,
  sessionId: string,
  message: ChatMessage,
) {
  qc.setQueryData<ChatMessage[]>(chatKeys.messages(sessionId), (old) => {
    if (!old) return old;
    if (old.some((m) => m.id === message.id)) return old;
    return [...old, message];
  });
}

export function onChatDone(qc: QueryClient, sessionId: string) {
  qc.invalidateQueries({ queryKey: chatKeys.messages(sessionId) });
}
