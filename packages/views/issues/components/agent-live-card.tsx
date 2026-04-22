"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Bot, ChevronRight, ChevronDown, Loader2, ArrowDown, ArrowRight, Brain, AlertCircle, Clock, CheckCircle2, XCircle, MinusCircle, Square, Maximize2, RotateCcw } from "lucide-react";
import { api } from "@multica/core/api";
import { useWSEvent } from "@multica/core/realtime";
import type { TaskMessagePayload, TaskCompletedPayload, TaskFailedPayload, TaskCancelledPayload } from "@multica/core/types/events";
import type { AgentTask } from "@multica/core/types/agent";
import { cn } from "@multica/ui/lib/utils";
import { toast } from "sonner";
import { ActorAvatar } from "../../common/actor-avatar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@multica/ui/components/ui/collapsible";
import { useActorName } from "@multica/core/workspace/hooks";
import { redactSecrets } from "../utils/redact";
import { AgentTranscriptDialog } from "./agent-transcript-dialog";
import { Markdown } from "@multica/ui/markdown";
import {
  ChainOfThought,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@multica/ui/components/ai-elements/chain-of-thought";

// ─── Shared types & helpers ─────────────────────────────────────────────────

/** A unified timeline entry: tool calls, thinking, text, and errors in chronological order. */
export interface TimelineItem {
  seq: number;
  type: "tool_use" | "tool_result" | "thinking" | "text" | "error" | "delegation" | "setup";
  tool?: string;
  content?: string;
  input?: Record<string, unknown>;
  output?: string;
  agent_name?: string;
  delegation_target?: string;
}

function formatElapsed(startedAt: string): string {
  const elapsed = Date.now() - new Date(startedAt).getTime();
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function shortenPath(p: string): string {
  const parts = p.split("/");
  if (parts.length <= 3) return p;
  return ".../" + parts.slice(-2).join("/");
}

function getToolSummary(item: TimelineItem): string {
  if (!item.input) return "";
  const inp = item.input as Record<string, string>;

  // WebSearch / web search
  if (inp.query) return inp.query;
  // File operations
  if (inp.file_path) return shortenPath(inp.file_path);
  if (inp.path) return shortenPath(inp.path);
  if (inp.pattern) return inp.pattern;
  // Bash
  if (inp.description) return String(inp.description);
  if (inp.command) {
    const cmd = String(inp.command);
    return cmd.length > 100 ? cmd.slice(0, 100) + "..." : cmd;
  }
  // Agent
  if (inp.prompt) {
    const p = String(inp.prompt);
    return p.length > 100 ? p.slice(0, 100) + "..." : p;
  }
  // Skill
  if (inp.skill) return String(inp.skill);
  // Fallback: show first string value
  for (const v of Object.values(inp)) {
    if (typeof v === "string" && v.length > 0 && v.length < 120) return v;
  }
  return "";
}

/** Build a chronologically ordered timeline from raw messages.
 *  Transforms ADK plumbing into user-facing events:
 *  - transfer_to_agent tool_use → delegation indicator
 *  - transfer_to_agent tool_result → removed (always null)
 *  - old text-type setup messages → setup type
 */
export function buildTimeline(msgs: TaskMessagePayload[]): TimelineItem[] {
  const SETUP_PATTERN = /^(Creating sandbox|Sandbox ready|Uploading agent|Starting agent)/;

  const items: TimelineItem[] = [];
  for (const msg of msgs) {
    const content = msg.content ? redactSecrets(msg.content) : msg.content;
    const output = msg.output ? redactSecrets(msg.output) : msg.output;

    // transfer_to_agent tool_use → delegation indicator
    if (msg.type === "tool_use" && msg.tool === "transfer_to_agent") {
      const target = (msg.input?.agent_name as string) || "agent";
      items.push({
        seq: msg.seq,
        type: "delegation",
        delegation_target: target,
        content: `Delegated to ${target}`,
        agent_name: msg.agent_name,
      });
      continue;
    }

    // transfer_to_agent tool_result → skip (always {"result": null})
    if (msg.type === "tool_result" && msg.tool === "transfer_to_agent") {
      continue;
    }

    // Old text-type setup messages → convert to setup type
    if (msg.type === "text" && content && SETUP_PATTERN.test(content)) {
      items.push({ seq: msg.seq, type: "setup", content });
      continue;
    }

    items.push({
      seq: msg.seq,
      type: msg.type as TimelineItem["type"],
      tool: msg.tool,
      content,
      input: msg.input,
      output,
      agent_name: msg.agent_name,
    });
  }
  return items.sort((a, b) => a.seq - b.seq);
}

// ─── Per-task state ─────────────────────────────────────────────────────────

interface TaskState {
  task: AgentTask;
  items: TimelineItem[];
}

// ─── AgentLiveCard (real-time view for multiple agents) ───────────────────

interface AgentLiveCardProps {
  issueId: string;
}

export function AgentLiveCard({ issueId }: AgentLiveCardProps) {
  const { getActorName } = useActorName();
  const [taskStates, setTaskStates] = useState<Map<string, TaskState>>(new Map());
  const seenSeqs = useRef(new Set<string>());

  // Fetch active tasks on mount
  useEffect(() => {
    let cancelled = false;
    api.getActiveTasksForIssue(issueId).then(({ tasks }) => {
      if (cancelled || tasks.length === 0) return;

      // Show cards immediately with empty timeline
      setTaskStates((prev) => {
        const next = new Map(prev);
        for (const task of tasks) {
          if (!next.has(task.id)) {
            next.set(task.id, { task, items: [] });
          }
        }
        return next;
      });

      // Load messages per task in the background
      for (const task of tasks) {
        api.listTaskMessages(task.id).then((msgs) => {
          if (cancelled) return;
          const timeline = buildTimeline(msgs);
          for (const m of msgs) seenSeqs.current.add(`${m.task_id}:${m.seq}`);
          setTaskStates((prev) => {
            const next = new Map(prev);
            const existing = next.get(task.id);
            if (existing) {
              // Merge: keep any WS-delivered items not in the loaded batch
              const loadedSeqs = new Set(timeline.map((i) => i.seq));
              const wsOnly = existing.items.filter((i) => !loadedSeqs.has(i.seq));
              const merged = [...timeline, ...wsOnly].sort((a, b) => a.seq - b.seq);
              next.set(task.id, { task: existing.task, items: merged });
            } else {
              next.set(task.id, { task, items: timeline });
            }
            return next;
          });
        }).catch(console.error);
      }
    }).catch(console.error);

    return () => { cancelled = true; };
  }, [issueId]);

  // Handle real-time task messages — route by task_id
  useWSEvent(
    "task:message",
    useCallback((payload: unknown) => {
      const msg = payload as TaskMessagePayload;
      if (msg.issue_id !== issueId) return;
      const key = `${msg.task_id}:${msg.seq}`;
      if (seenSeqs.current.has(key)) return;
      seenSeqs.current.add(key);

      const item: TimelineItem = {
        seq: msg.seq,
        type: msg.type,
        tool: msg.tool,
        content: msg.content,
        input: msg.input,
        output: msg.output,
        agent_name: msg.agent_name,
      };

      setTaskStates((prev) => {
        const next = new Map(prev);
        const existing = next.get(msg.task_id);
        if (existing) {
          const items = [...existing.items, item].sort((a, b) => a.seq - b.seq);
          next.set(msg.task_id, { ...existing, items });
        } else {
          // Task entry not yet created (dispatch event may arrive late for sandbox agents).
          // Create a placeholder entry so messages aren't dropped.
          next.set(msg.task_id, {
            task: { id: msg.task_id, status: "running" } as AgentTask,
            items: [item],
          });
        }
        return next;
      });
    }, [issueId]),
  );

  // Handle task end events — remove only the specific task
  const handleTaskEnd = useCallback((payload: unknown) => {
    const p = payload as { task_id: string; issue_id: string };
    if (p.issue_id !== issueId) return;
    setTaskStates((prev) => {
      const next = new Map(prev);
      next.delete(p.task_id);
      return next;
    });
  }, [issueId]);

  useWSEvent("task:completed", handleTaskEnd);
  useWSEvent("task:failed", handleTaskEnd);
  useWSEvent("task:cancelled", handleTaskEnd);

  // Pick up newly dispatched tasks
  useWSEvent(
    "task:dispatch",
    useCallback((payload: unknown) => {
      const p = payload as { issue_id?: string };
      if (p.issue_id && p.issue_id !== issueId) return;
      api.getActiveTasksForIssue(issueId).then(({ tasks }) => {
        setTaskStates((prev) => {
          const next = new Map(prev);
          for (const task of tasks) {
            if (!next.has(task.id)) {
              next.set(task.id, { task, items: [] });
            }
          }
          return next;
        });
      }).catch(console.error);
    }, [issueId]),
  );

  if (taskStates.size === 0) return null;

  const entries = Array.from(taskStates.values());
  const [firstEntry, ...restEntries] = entries;
  if (!firstEntry) return null;

  return (
    <>
      {/* Primary agent — sticky at top of the Activity section */}
      <div className="mt-4 sticky top-4 z-10">
        <SingleAgentLiveCard
          task={firstEntry.task}
          items={firstEntry.items}
          issueId={issueId}
          agentName={firstEntry.task.agent_id ? getActorName("agent", firstEntry.task.agent_id) : "Agent"}
        />
      </div>
      {/* Additional agents — scroll with the page */}
      {restEntries.length > 0 && (
        <div className="mt-1.5 space-y-1.5">
          {restEntries.map(({ task, items }) => (
            <SingleAgentLiveCard
              key={task.id}
              task={task}
              items={items}
              issueId={issueId}
              agentName={task.agent_id ? getActorName("agent", task.agent_id) : "Agent"}
            />
          ))}
        </div>
      )}
    </>
  );
}

// ─── SingleAgentLiveCard (one card per running task) ──────────────────────

interface SingleAgentLiveCardProps {
  task: AgentTask;
  items: TimelineItem[];
  issueId: string;
  agentName: string;
}

function SingleAgentLiveCard({ task, items, issueId, agentName }: SingleAgentLiveCardProps) {
  const [elapsed, setElapsed] = useState("");
  const [open, setOpen] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Elapsed time
  useEffect(() => {
    if (!task.started_at && !task.dispatched_at) return;
    const startRef = task.started_at ?? task.dispatched_at!;
    setElapsed(formatElapsed(startRef));
    const interval = setInterval(() => setElapsed(formatElapsed(startRef)), 1000);
    return () => clearInterval(interval);
  }, [task.started_at, task.dispatched_at]);

  // Auto-scroll timeline to bottom
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [items, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  }, []);

  const toggleOpen = useCallback(() => {
    setOpen(!open);
  }, [open]);

  const handleCancel = useCallback(async () => {
    if (cancelling) return;
    setCancelling(true);
    const timeoutId = setTimeout(() => {
      setCancelling(false);
      toast.error("Cancel timed out — try again");
    }, 10_000);
    try {
      await api.cancelTask(issueId, task.id);
      clearTimeout(timeoutId);
    } catch (e) {
      clearTimeout(timeoutId);
      toast.error(e instanceof Error ? e.message : "Failed to cancel task");
      setCancelling(false);
    }
  }, [task.id, issueId, cancelling]);

  const toolCount = items.filter((i) => i.type === "tool_use").length;
  const subAgentNames = [...new Set(items.filter((i) => i.agent_name && i.agent_name !== "multica_agent").map((i) => i.agent_name!))];

  return (
    <div className="rounded-lg border border-info/20 bg-info/5 backdrop-blur-sm">
      {/* Header — click to toggle timeline */}
      <div
        className="group flex items-center gap-2 px-3 py-2 cursor-pointer select-none text-muted-foreground hover:text-foreground transition-colors"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggleOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleOpen();
          }
        }}
      >
        {task.agent_id ? (
          <ActorAvatar actorType="agent" actorId={task.agent_id} size={20} />
        ) : (
          <div className="flex items-center justify-center h-5 w-5 rounded-full shrink-0 bg-info/10 text-info">
            <Bot className="h-3 w-3" />
          </div>
        )}
        <div className="flex items-center gap-1.5 text-xs min-w-0">
          <Loader2 className="h-3 w-3 animate-spin text-info shrink-0" />
          <span className="font-medium text-foreground truncate">{agentName} is working</span>
          <span className="text-muted-foreground tabular-nums shrink-0">{elapsed}</span>
          {toolCount > 0 && (
            <span className="text-muted-foreground shrink-0">{toolCount} tools</span>
          )}
          {subAgentNames.map((name) => (
            <AgentBadge key={name} name={name} />
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); setTranscriptOpen(true); }}
            className="flex items-center justify-center rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            title="Expand transcript"
          >
            <Maximize2 className="h-3 w-3" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleCancel(); }}
            disabled={cancelling}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
            title="Stop agent"
          >
            {cancelling ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
            <span>Stop</span>
          </button>
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
        </div>
      </div>

      {/* Timeline — grid-rows animation for smooth collapse/expand */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          {items.length > 0 ? (
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="relative max-h-80 overflow-y-auto overscroll-y-contain border-t border-info/10 px-3 py-2 space-y-0.5"
            >
              {renderTimelineItems(items)}

              {!autoScroll && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (scrollRef.current) {
                      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                      setAutoScroll(true);
                    }
                  }}
                  className="sticky bottom-0 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full bg-background border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground shadow-sm"
                >
                  <ArrowDown className="h-3 w-3" />
                  Latest
                </button>
              )}
            </div>
          ) : (
            <div className="border-t border-info/10 px-3 py-3">
              <p className="text-xs text-muted-foreground">
                Live log is not available for this agent provider. Results will appear when the task completes.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Fullscreen transcript dialog */}
      <AgentTranscriptDialog
        open={transcriptOpen}
        onOpenChange={setTranscriptOpen}
        task={task}
        items={items}
        agentName={agentName}
        isLive
      />
    </div>
  );
}

// ─── TaskRunHistory (past execution logs) ──────────────────────────────────

interface TaskRunHistoryProps {
  issueId: string;
}

export function TaskRunHistory({ issueId }: TaskRunHistoryProps) {
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api.listTasksByIssue(issueId).then(setTasks).catch(console.error);
  }, [issueId]);

  // Refresh when a task completes
  useWSEvent(
    "task:completed",
    useCallback((payload: unknown) => {
      const p = payload as TaskCompletedPayload;
      if (p.issue_id !== issueId) return;
      api.listTasksByIssue(issueId).then(setTasks).catch(console.error);
    }, [issueId]),
  );

  useWSEvent(
    "task:failed",
    useCallback((payload: unknown) => {
      const p = payload as TaskFailedPayload;
      if (p.issue_id !== issueId) return;
      api.listTasksByIssue(issueId).then(setTasks).catch(console.error);
    }, [issueId]),
  );

  // Refresh when a task is cancelled
  useWSEvent(
    "task:cancelled",
    useCallback((payload: unknown) => {
      const p = payload as TaskCancelledPayload;
      if (p.issue_id !== issueId) return;
      api.listTasksByIssue(issueId).then(setTasks).catch(console.error);
    }, [issueId]),
  );

  // Refresh when a new task is dispatched (retry creates a task with
  // retried_from_id — re-fetching hides the Retry button on the original).
  useWSEvent(
    "task:dispatch",
    useCallback((payload: unknown) => {
      const p = payload as { issue_id?: string };
      if (p.issue_id !== issueId) return;
      api.listTasksByIssue(issueId).then(setTasks).catch(console.error);
    }, [issueId]),
  );

  const completedTasks = tasks.filter((t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled" || t.status === "waiting");
  if (completedTasks.length === 0) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1">
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
        <Clock className="h-3 w-3" />
        <span>Execution history ({completedTasks.length})</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 space-y-2">
          {completedTasks.map((task) => (
            <TaskRunEntry key={task.id} task={task} allTasks={tasks} onRetried={() => {
              api.listTasksByIssue(issueId).then(setTasks).catch(console.error);
            }} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TaskRunEntry({ task, allTasks, onRetried }: { task: AgentTask; allTasks: AgentTask[]; onRetried: () => void }) {
  const { getActorName } = useActorName();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<TimelineItem[] | null>(null);
  const [childTasks, setChildTasks] = useState<AgentTask[]>([]);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retried, setRetried] = useState(false);

  const isOrchestrator = task.role === "orchestrator" || task.role === "synthesizer" || task.status === "waiting";

  const loadMessages = useCallback(() => {
    if (items !== null) return; // already loaded
    api.listTaskMessages(task.id).then((msgs) => {
      setItems(buildTimeline(msgs));
    }).catch((e) => {
      console.error(e);
      setItems([]);
    });
  }, [task.id, items]);

  useEffect(() => {
    if (open) {
      loadMessages();
      if (isOrchestrator) {
        api.listChildTasks(task.id).then(setChildTasks).catch(console.error);
      }
    }
  }, [open, loadMessages, isOrchestrator, task.id]);

  const duration = task.started_at && task.completed_at
    ? formatDuration(task.started_at, task.completed_at)
    : null;

  const isRetryable = task.status === "failed" || task.status === "cancelled";
  const alreadyRetried = retried || allTasks.some((t) => t.retried_from_id === task.id);
  const hasActiveTask = allTasks.some((t) => t.status === "queued" || t.status === "dispatched" || t.status === "running");
  const showRetryButton = isRetryable && !alreadyRetried && !hasActiveTask;

  const handleRetry = useCallback(async () => {
    if (retrying || alreadyRetried) return;
    setRetrying(true);
    try {
      await api.retryTask(task.id);
      setRetried(true);
      onRetried();
    } catch (e) {
      const raw = e instanceof Error ? e.message : "Failed to retry task";
      // Translate backend errors into user-friendly messages.
      const msg = raw.includes("issue is done") || raw.includes("issue is closed")
        ? "This issue is marked as done — change its status to retry"
        : raw.includes("active task")
          ? "A task is already running — wait for it to finish"
          : raw;
      toast.error(msg);
      setRetrying(false);
    }
  }, [task.id, retrying, alreadyRetried, onRetried]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/30 transition-colors border border-transparent hover:border-border">
        <ChevronRight className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        {task.status === "completed" ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
        ) : task.status === "cancelled" ? (
          <MinusCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        )}
        <span className="text-muted-foreground">
          {new Date(task.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        </span>
        {duration && <span className="text-muted-foreground">{duration}</span>}
        {showRetryButton && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); if (!retrying) handleRetry(); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); if (!retrying) handleRetry(); } }}
            className={cn("ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer", retrying && "opacity-50 pointer-events-none")}
            title="Retry this task"
          >
            {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
            <span>{retrying ? "Retrying..." : "Retry"}</span>
          </span>
        )}
        <span className={cn(
          !showRetryButton && "ml-auto",
          "capitalize",
          task.status === "completed" ? "text-success" : task.status === "cancelled" ? "text-muted-foreground" : "text-destructive",
        )}>
          {task.status}
        </span>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            // Load messages before opening the transcript dialog
            if (items === null) {
              api.listTaskMessages(task.id).then((msgs) => {
                setItems(buildTimeline(msgs));
                setTranscriptOpen(true);
              }).catch(console.error);
            } else {
              setTranscriptOpen(true);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.click();
            }
          }}
          className="flex items-center justify-center rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
          title="Expand transcript"
        >
          <Maximize2 className="h-3 w-3" />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-5 mt-1 max-h-80 overflow-y-auto rounded border bg-muted/30 px-3 py-2 space-y-0.5">
          {items === null ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading...
            </div>
          ) : items.length === 0 && childTasks.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">No execution data recorded.</p>
          ) : (
            <>
              {renderTimelineItems(items)}
              {childTasks.length > 0 && (
                <ChainOfThought defaultOpen className="mt-2 pt-2 border-t border-border/50">
                  <ChainOfThoughtHeader>
                    {childTasks.filter((c) => c.status === "completed").length}/{childTasks.length} tasks complete
                  </ChainOfThoughtHeader>
                  {childTasks.map((child) => (
                    <ChainOfThoughtStep
                      key={child.id}
                      icon={Bot}
                      label={getActorName("agent", child.agent_id)}
                      description={child.status === "completed" && child.started_at && child.completed_at
                        ? formatDuration(child.started_at, child.completed_at)
                        : child.status}
                      status={
                        child.status === "completed" ? "complete" :
                        child.status === "running" || child.status === "dispatched" ? "active" :
                        "pending"
                      }
                    />
                  ))}
                </ChainOfThought>
              )}
            </>
          )}
        </div>
      </CollapsibleContent>

      {/* Fullscreen transcript dialog */}
      {items !== null && (
        <AgentTranscriptDialog
          open={transcriptOpen}
          onOpenChange={setTranscriptOpen}
          task={task}
          items={items}
          agentName={task.agent_id ? getActorName("agent", task.agent_id) : "Agent"}
        />
      )}
    </Collapsible>
  );
}

// ─── Shared timeline row rendering ──────────────────────────────────────────

function AgentBadge({ name }: { name?: string }) {
  if (!name || name === "multica_agent") return null;
  return (
    <span className="inline-flex items-center rounded px-1 py-0.5 text-[10px] font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 mr-1">
      {name}
    </span>
  );
}

function TickerPreview({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const startScroll = useCallback(() => {
    const el = ref.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    intervalRef.current = setInterval(() => {
      if (!ref.current) return;
      if (ref.current.scrollLeft >= ref.current.scrollWidth - ref.current.clientWidth) {
        clearInterval(intervalRef.current);
        return;
      }
      ref.current.scrollLeft += 1;
    }, 20);
  }, []);

  const stopScroll = useCallback(() => {
    clearInterval(intervalRef.current);
    if (ref.current) ref.current.scrollTo({ left: 0, behavior: "smooth" });
  }, []);

  return (
    <span
      ref={ref}
      className="text-muted-foreground/50 min-w-0 overflow-hidden whitespace-nowrap"
      onMouseEnter={startScroll}
      onMouseLeave={stopScroll}
    >
      {text}
    </span>
  );
}

function SubAgentCollapsible({ name, content, children }: { name: string; content?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  // Extract first sentence as preview (strip leading markdown headings).
  const firstSentence = content
    ? content.replace(/^#+\s*/m, "").split(/(?<=[.!?])\s/)[0]?.trim() || ""
    : "";
  const wordCount = content ? content.trim().split(/\s+/).length : 0;
  const readTime = wordCount > 0 ? Math.ceil(wordCount / 200) : 0;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 rounded px-1 -mx-1 py-0.5 text-xs hover:bg-accent/30 transition-colors max-w-full">
        <ChevronRight className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <AgentBadge name={name} />
        {!open && firstSentence && (
          <TickerPreview text={firstSentence} />
        )}
        {!open && readTime > 0 && (
          <span className="text-muted-foreground/40 shrink-0 tabular-nums">{readTime} min read</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-4 border-l border-purple-200 dark:border-purple-800/40 pl-2">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Render timeline items, grouping consecutive setup items into a stepper. */
function renderTimelineItems(items: TimelineItem[]) {
  const elements: React.ReactNode[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i]!;
    if (item.type === "setup") {
      const steps: TimelineItem[] = [];
      while (i < items.length && items[i]!.type === "setup") {
        steps.push(items[i]!);
        i++;
      }
      const isComplete = i < items.length;
      elements.push(<SetupStepperRow key={`setup-${steps[0]!.seq}`} steps={steps} isComplete={isComplete} />);
    } else {
      elements.push(<TimelineRow key={`${item.seq}-${i}`} item={item} />);
      i++;
    }
  }
  return elements;
}

function DelegationRow({ item }: { item: TimelineItem }) {
  return (
    <div className="flex items-center gap-1.5 px-1 -mx-1 py-1 text-xs">
      <ArrowRight className="h-3 w-3 shrink-0 text-purple-500" />
      <span className="text-muted-foreground">
        Delegated to{" "}
        <span className="font-medium text-foreground">{item.delegation_target}</span>
      </span>
    </div>
  );
}

function SetupStepperRow({ steps, isComplete }: { steps: TimelineItem[]; isComplete: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 rounded px-1 -mx-1 py-0.5 text-xs text-muted-foreground hover:bg-accent/30 transition-colors">
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        {isComplete ? (
          <CheckCircle2 className="h-3 w-3 shrink-0 text-success" />
        ) : (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-info" />
        )}
        <span>{isComplete ? "Environment ready" : "Setting up..."}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-4 space-y-0.5 py-0.5">
          {steps.map((step, i) => {
            const isDone = i < steps.length - 1 || isComplete;
            return (
              <div key={step.seq} className="flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground/70">
                {isDone ? (
                  <CheckCircle2 className="h-3 w-3 shrink-0 text-success/60" />
                ) : (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin text-info/60" />
                )}
                <span>{step.content}</span>
              </div>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  // Delegation rows render standalone — no SubAgentCollapsible wrapping
  if (item.type === "delegation") {
    return <DelegationRow item={item} />;
  }

  const badge = item.agent_name && item.agent_name !== "multica_agent" ? (
    <AgentBadge name={item.agent_name} />
  ) : null;

  const row = (() => {
    switch (item.type) {
      case "tool_use":
        return <ToolCallRow item={item} />;
      case "tool_result":
        return <ToolResultRow item={item} />;
      case "thinking":
        return <ThinkingRow item={item} />;
      case "text":
        return <TextRow item={item} />;
      case "error":
        return <ErrorRow item={item} />;
      default:
        return null;
    }
  })();

  if (!badge || !row) return row;
  return (
    <SubAgentCollapsible name={item.agent_name!} content={item.content}>
      {row}
    </SubAgentCollapsible>
  );
}

function ToolCallRow({ item }: { item: TimelineItem }) {
  const [open, setOpen] = useState(false);
  const summary = getToolSummary(item);
  const hasInput = item.input && Object.keys(item.input).length > 0;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded px-1 -mx-1 py-0.5 text-xs hover:bg-accent/30 transition-colors">
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
            !hasInput && "invisible",
          )}
        />
        <span className="font-medium text-foreground shrink-0">{item.tool}</span>
        {summary && <span className="truncate text-muted-foreground">{summary}</span>}
      </CollapsibleTrigger>
      {hasInput && (
        <CollapsibleContent>
          <pre className="ml-[18px] mt-0.5 max-h-32 overflow-auto rounded bg-muted/50 p-2 text-[11px] text-muted-foreground whitespace-pre-wrap break-all">
            {redactSecrets(JSON.stringify(item.input, null, 2))}
          </pre>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

function ToolResultRow({ item }: { item: TimelineItem }) {
  const [open, setOpen] = useState(false);
  const output = item.output ?? "";
  if (!output) return null;

  const preview = output.length > 120 ? output.slice(0, 120) + "..." : output;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-start gap-1.5 rounded px-1 -mx-1 py-0.5 text-xs hover:bg-accent/30 transition-colors">
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform mt-0.5", open && "rotate-90")}
        />
        <span className="text-muted-foreground/70 truncate">
          {item.tool ? `${item.tool} result: ` : "result: "}{preview}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="ml-[18px] mt-0.5 max-h-40 overflow-auto rounded bg-muted/50 p-2 text-[11px] text-muted-foreground whitespace-pre-wrap break-all">
          {output.length > 4000 ? output.slice(0, 4000) + "\n... (truncated)" : output}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ThinkingRow({ item }: { item: TimelineItem }) {
  const [open, setOpen] = useState(false);
  const text = item.content ?? "";
  if (!text) return null;

  const preview = text.length > 150 ? text.slice(0, 150) + "..." : text;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-start gap-1.5 rounded px-1 -mx-1 py-0.5 text-xs hover:bg-accent/30 transition-colors">
        <Brain className="h-3 w-3 shrink-0 text-info/60 mt-0.5" />
        <span className="text-muted-foreground italic truncate">{preview}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="ml-[18px] mt-0.5 max-h-40 overflow-auto rounded bg-info/5 p-2 text-[11px] text-muted-foreground whitespace-pre-wrap break-words">
          {text}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TextRow({ item }: { item: TimelineItem }) {
  const text = item.content ?? "";
  if (!text.trim()) return null;

  return (
    <div className="flex items-start gap-1.5 px-1 -mx-1 py-0.5 text-xs">
      <span className="h-3 w-3 shrink-0" />
      <div className="text-muted-foreground/60 min-w-0 flex-1 overflow-hidden prose-sm [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_p]:text-xs [&_li]:text-xs [&_ul]:my-1 [&_ol]:my-1 [&_p]:my-1">
        <Markdown mode="minimal">{text}</Markdown>
      </div>
    </div>
  );
}

function ErrorRow({ item }: { item: TimelineItem }) {
  return (
    <div className="flex items-start gap-1.5 px-1 -mx-1 py-0.5 text-xs">
      <AlertCircle className="h-3 w-3 shrink-0 text-destructive mt-0.5" />
      <span className="text-destructive">{item.content}</span>
    </div>
  );
}
