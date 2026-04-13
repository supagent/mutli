"use client";

import { MessageCircle } from "lucide-react";
import { useChatStore } from "@multica/core/chat";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@multica/ui/components/ui/tooltip";

export function ChatFab() {
  const isOpen = useChatStore((s) => s.isOpen);
  const toggle = useChatStore((s) => s.toggle);

  if (isOpen) return null;

  return (
    <Tooltip delay={300}>
      <TooltipTrigger
        onClick={toggle}
        className="fixed bottom-4 right-4 z-50 flex size-10 cursor-pointer items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-transform hover:scale-110 hover:text-accent-foreground active:scale-95"
      >
        <MessageCircle className="size-5" />
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={10}>Ask Multica</TooltipContent>
    </Tooltip>
  );
}
