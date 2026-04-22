import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { AgentTask } from "@multica/core/types/agent";

// ---------------------------------------------------------------------------
// Mocks — must be before imports that use them
// ---------------------------------------------------------------------------

const mockRetryTask = vi.fn();
const mockListTasksByIssue = vi.fn();
const mockGetActiveTasksForIssue = vi.fn();
const mockListTaskMessages = vi.fn();
const mockCancelTask = vi.fn();

vi.mock("@multica/core/api", () => ({
  api: {
    retryTask: (...args: any[]) => mockRetryTask(...args),
    listTasksByIssue: (...args: any[]) => mockListTasksByIssue(...args),
    getActiveTasksForIssue: (...args: any[]) => mockGetActiveTasksForIssue(...args),
    listTaskMessages: (...args: any[]) => mockListTaskMessages(...args),
    cancelTask: (...args: any[]) => mockCancelTask(...args),
  },
}));

vi.mock("@multica/core/realtime", () => ({
  useWSEvent: vi.fn(),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: () => "Test Agent",
    getMemberName: () => "Test User",
    getAgentName: () => "Test Agent",
    getActorInitials: () => "TA",
    getActorAvatarUrl: () => null,
  }),
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: () => <div data-testid="actor-avatar" />,
}));

vi.mock("./agent-transcript-dialog", () => ({
  AgentTranscriptDialog: () => null,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@multica/ui/markdown", () => ({
  Markdown: ({ children }: { children: string }) => (
    <div data-testid="markdown-content">{children}</div>
  ),
}));

// Import after mocks
import { TaskRunHistory, buildTimeline } from "./agent-live-card";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    agent_id: "agent-1",
    runtime_id: "runtime-1",
    issue_id: "issue-1",
    status: "failed",
    priority: 0,
    dispatched_at: "2026-04-16T02:28:00Z",
    started_at: "2026-04-16T02:28:01Z",
    completed_at: "2026-04-16T02:28:13Z",
    result: null,
    error: "Sandbox timeout after 150s",
    retried_from_id: null,
    created_at: "2026-04-16T02:28:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TaskRunEntry retry button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveTasksForIssue.mockResolvedValue({ tasks: [] });
    mockListTaskMessages.mockResolvedValue([]);
  });

  it("shows retry button for failed tasks", async () => {
    const failedTask = makeTask({ status: "failed" });
    mockListTasksByIssue.mockResolvedValue([failedTask]);

    render(<TaskRunHistory issueId="issue-1" />);
    await waitFor(() => expect(screen.getByText(/Execution history/)).toBeInTheDocument());

    // Expand the history
    fireEvent.click(screen.getByText(/Execution history/));

    await waitFor(() => expect(screen.getByText("Retry")).toBeInTheDocument());
  });

  it("shows retry button for cancelled tasks", async () => {
    const cancelledTask = makeTask({ status: "cancelled" });
    mockListTasksByIssue.mockResolvedValue([cancelledTask]);

    render(<TaskRunHistory issueId="issue-1" />);
    await waitFor(() => expect(screen.getByText(/Execution history/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Execution history/));

    await waitFor(() => expect(screen.getByText("Retry")).toBeInTheDocument());
  });

  it("does not show retry button for completed tasks", async () => {
    const completedTask = makeTask({ status: "completed", error: null });
    mockListTasksByIssue.mockResolvedValue([completedTask]);

    render(<TaskRunHistory issueId="issue-1" />);
    await waitFor(() => expect(screen.getByText(/Execution history/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Execution history/));

    await waitFor(() => expect(screen.getByText("completed")).toBeInTheDocument());
    expect(screen.queryByText("Retry")).not.toBeInTheDocument();
  });

  it("hides retry button when active task exists on issue", async () => {
    const failedTask = makeTask({ id: "task-1", status: "failed" });
    const runningTask = makeTask({ id: "task-2", status: "running", error: null });
    mockListTasksByIssue.mockResolvedValue([runningTask, failedTask]);

    render(<TaskRunHistory issueId="issue-1" />);
    await waitFor(() => expect(screen.getByText(/Execution history/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Execution history/));

    // Failed task is visible but Retry button is hidden (active task running)
    await waitFor(() => expect(screen.getByText("failed")).toBeInTheDocument());
    expect(screen.queryByText("Retry")).not.toBeInTheDocument();
  });

  it("hides retry button when task was already retried", async () => {
    const originalTask = makeTask({ id: "task-1", status: "failed" });
    const retryTask = makeTask({ id: "task-2", status: "completed", error: null, retried_from_id: "task-1" });
    mockListTasksByIssue.mockResolvedValue([retryTask, originalTask]);

    render(<TaskRunHistory issueId="issue-1" />);
    await waitFor(() => expect(screen.getByText(/Execution history/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Execution history/));

    // The original task should not have a Retry button (already retried)
    await waitFor(() => expect(screen.getByText("failed")).toBeInTheDocument());
    expect(screen.queryByText("Retry")).not.toBeInTheDocument();
  });

  it("calls api.retryTask on click, hides button, and refreshes list", async () => {
    const failedTask = makeTask({ status: "failed" });
    mockListTasksByIssue.mockResolvedValue([failedTask]);
    mockRetryTask.mockResolvedValue(makeTask({ id: "task-2", status: "queued" }));

    render(<TaskRunHistory issueId="issue-1" />);
    await waitFor(() => expect(screen.getByText(/Execution history/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Execution history/));

    await waitFor(() => expect(screen.getByText("Retry")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Retry"));

    // Shows "Retrying..." during the request
    await waitFor(() => expect(screen.getByText("Retrying...")).toBeInTheDocument());

    // After success, button disappears and task list refreshes
    await waitFor(() => expect(screen.queryByText("Retry")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText("Retrying...")).not.toBeInTheDocument());
    expect(mockListTasksByIssue).toHaveBeenCalledWith("issue-1");
  });

  it("reverts to Retry button on failure", async () => {
    const failedTask = makeTask({ status: "failed" });
    mockListTasksByIssue.mockResolvedValue([failedTask]);
    mockRetryTask.mockRejectedValue(new Error("an active task already exists"));

    render(<TaskRunHistory issueId="issue-1" />);
    await waitFor(() => expect(screen.getByText(/Execution history/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Execution history/));

    await waitFor(() => expect(screen.getByText("Retry")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Retry"));

    // After failure, button reverts back to "Retry"
    await waitFor(() => expect(screen.getByText("Retry")).toBeInTheDocument());
  });

  it("shows user-friendly toast for closed issue", async () => {
    const { toast } = await import("sonner");
    const failedTask = makeTask({ status: "failed" });
    mockListTasksByIssue.mockResolvedValue([failedTask]);
    mockRetryTask.mockRejectedValue(new Error("cannot retry: issue is done"));

    render(<TaskRunHistory issueId="issue-1" />);
    await waitFor(() => expect(screen.getByText(/Execution history/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Execution history/));

    await waitFor(() => expect(screen.getByText("Retry")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Retry"));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      "This issue is marked as done — change its status to retry"
    ));
  });

  it("shows user-friendly toast for active task conflict", async () => {
    const { toast } = await import("sonner");
    const failedTask = makeTask({ status: "failed" });
    mockListTasksByIssue.mockResolvedValue([failedTask]);
    mockRetryTask.mockRejectedValue(new Error("an active task already exists for this issue"));

    render(<TaskRunHistory issueId="issue-1" />);
    await waitFor(() => expect(screen.getByText(/Execution history/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Execution history/));

    await waitFor(() => expect(screen.getByText("Retry")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Retry"));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      "A task is already running — wait for it to finish"
    ));
  });
});

describe("Multi-agent timeline rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveTasksForIssue.mockResolvedValue({ tasks: [] });
    mockListTaskMessages.mockResolvedValue([]);
  });

  async function expandHistory() {
    await waitFor(() => expect(screen.getByText(/Execution history/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Execution history/));
  }

  async function expandTaskEntry() {
    // The task entry trigger contains the status text "completed" (displayed capitalized)
    const statusEl = await waitFor(() => screen.getByText("completed"));
    const trigger = statusEl.closest("button") || statusEl.parentElement;
    if (trigger) fireEvent.click(trigger);
  }

  it("renders agent badge for sub-agent text events", async () => {
    const task = makeTask({ status: "completed" });
    mockListTasksByIssue.mockResolvedValue([task]);
    mockListTaskMessages.mockResolvedValue([
      { task_id: "task-1", issue_id: "issue-1", seq: 1, type: "text", content: "Setup...", agent_name: "" },
      { task_id: "task-1", issue_id: "issue-1", seq: 2, type: "text", content: "Research output", agent_name: "Researcher" },
    ]);

    render(<TaskRunHistory issueId="issue-1" />);
    await expandHistory();
    await expandTaskEntry();

    await waitFor(() => expect(screen.getByText("Researcher")).toBeInTheDocument());
  });

  it("renders sub-agent text via Markdown component", async () => {
    const task = makeTask({ status: "completed" });
    mockListTasksByIssue.mockResolvedValue([task]);
    mockListTaskMessages.mockResolvedValue([
      { task_id: "task-1", issue_id: "issue-1", seq: 1, type: "text", content: "# Heading\n\n- bullet", agent_name: "Researcher" },
    ]);

    render(<TaskRunHistory issueId="issue-1" />);
    await expandHistory();
    await expandTaskEntry();

    // Expand the sub-agent collapsible to reveal markdown content
    const badge = await waitFor(() => screen.getByText("Researcher"));
    fireEvent.click(badge.closest("button") || badge);

    // Markdown mock renders content inside data-testid="markdown-content"
    await waitFor(() => expect(screen.getByTestId("markdown-content")).toBeInTheDocument());
  });

  it("does not render badge for multica_agent events", async () => {
    const task = makeTask({ status: "completed" });
    mockListTasksByIssue.mockResolvedValue([task]);
    mockListTaskMessages.mockResolvedValue([
      { task_id: "task-1", issue_id: "issue-1", seq: 1, type: "tool_use", tool: "get_issue", agent_name: "multica_agent", input: { issue_id: "123" } },
    ]);

    render(<TaskRunHistory issueId="issue-1" />);
    await expandHistory();
    await expandTaskEntry();

    await waitFor(() => expect(screen.getByText("get_issue")).toBeInTheDocument());
    // multica_agent should NOT render as a badge
    expect(screen.queryByText("multica_agent")).not.toBeInTheDocument();
  });
});

describe("buildTimeline delegation transform", () => {
  it("converts transfer_to_agent tool_use into delegation item", () => {
    const msgs = [
      { task_id: "t1", issue_id: "i1", seq: 1, type: "tool_use" as const, tool: "transfer_to_agent", input: { agent_name: "Researcher" }, agent_name: "multica_agent" },
      { task_id: "t1", issue_id: "i1", seq: 2, type: "tool_result" as const, tool: "transfer_to_agent", output: '{"result": null}', agent_name: "multica_agent" },
      { task_id: "t1", issue_id: "i1", seq: 3, type: "text" as const, content: "Research findings", agent_name: "Researcher" },
    ];
    const items = buildTimeline(msgs);
    const delegation = items.find(i => i.type === "delegation");
    expect(delegation).toBeDefined();
    expect(delegation!.delegation_target).toBe("Researcher");
  });

  it("removes transfer_to_agent tool_result (always null)", () => {
    const msgs = [
      { task_id: "t1", issue_id: "i1", seq: 1, type: "tool_use" as const, tool: "transfer_to_agent", input: { agent_name: "Researcher" }, agent_name: "multica_agent" },
      { task_id: "t1", issue_id: "i1", seq: 2, type: "tool_result" as const, tool: "transfer_to_agent", output: '{"result": null}', agent_name: "multica_agent" },
    ];
    const items = buildTimeline(msgs);
    const toolResults = items.filter(i => i.type === "tool_result" && i.tool === "transfer_to_agent");
    expect(toolResults).toHaveLength(0);
  });

  it("handles chained delegations (researcher → writer)", () => {
    const msgs = [
      { task_id: "t1", issue_id: "i1", seq: 1, type: "tool_use" as const, tool: "transfer_to_agent", input: { agent_name: "Researcher" }, agent_name: "multica_agent" },
      { task_id: "t1", issue_id: "i1", seq: 2, type: "tool_result" as const, tool: "transfer_to_agent", output: '{"result": null}', agent_name: "multica_agent" },
      { task_id: "t1", issue_id: "i1", seq: 3, type: "text" as const, content: "Findings", agent_name: "Researcher" },
      { task_id: "t1", issue_id: "i1", seq: 4, type: "tool_use" as const, tool: "transfer_to_agent", input: { agent_name: "Writer" }, agent_name: "Researcher" },
      { task_id: "t1", issue_id: "i1", seq: 5, type: "tool_result" as const, tool: "transfer_to_agent", output: '{"result": null}', agent_name: "Researcher" },
      { task_id: "t1", issue_id: "i1", seq: 6, type: "text" as const, content: "Report", agent_name: "Writer" },
    ];
    const items = buildTimeline(msgs);
    const delegations = items.filter(i => i.type === "delegation");
    expect(delegations).toHaveLength(2);
    expect(delegations[0]!.delegation_target).toBe("Researcher");
    expect(delegations[1]!.delegation_target).toBe("Writer");
  });

  it("preserves normal tool calls unchanged", () => {
    const msgs = [
      { task_id: "t1", issue_id: "i1", seq: 1, type: "tool_use" as const, tool: "research_tool", input: { query: "AI" }, agent_name: "Researcher" },
      { task_id: "t1", issue_id: "i1", seq: 2, type: "tool_result" as const, tool: "research_tool", output: '{"data": true}', agent_name: "Researcher" },
    ];
    const items = buildTimeline(msgs);
    expect(items).toHaveLength(2);
    expect(items[0]!.type).toBe("tool_use");
    expect(items[0]!.tool).toBe("research_tool");
    expect(items[1]!.type).toBe("tool_result");
  });

  it("converts old text-type setup messages to setup type", () => {
    const msgs = [
      { task_id: "t1", issue_id: "i1", seq: 1, type: "text" as const, content: "Creating sandbox environment...Sandbox ready. Uploading agent...Starting agent..." },
    ];
    const items = buildTimeline(msgs);
    expect(items[0]!.type).toBe("setup");
  });

  it("passes through new setup-type messages unchanged", () => {
    const msgs = [
      { task_id: "t1", issue_id: "i1", seq: 1, type: "setup" as const, content: "Creating sandbox" },
      { task_id: "t1", issue_id: "i1", seq: 2, type: "setup" as const, content: "Uploading agent" },
      { task_id: "t1", issue_id: "i1", seq: 3, type: "setup" as const, content: "Starting agent" },
    ];
    const items = buildTimeline(msgs);
    const setupItems = items.filter(i => i.type === "setup");
    expect(setupItems).toHaveLength(3);
  });
});

describe("Delegation row rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveTasksForIssue.mockResolvedValue({ tasks: [] });
    mockListTaskMessages.mockResolvedValue([]);
  });

  async function expandHistory() {
    await waitFor(() => expect(screen.getByText(/Execution history/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Execution history/));
  }

  async function expandTaskEntry() {
    const statusEl = await waitFor(() => screen.getByText("completed"));
    const trigger = statusEl.closest("button") || statusEl.parentElement;
    if (trigger) fireEvent.click(trigger);
  }

  it("renders 'Delegated to' text instead of transfer_to_agent", async () => {
    const task = makeTask({ status: "completed" });
    mockListTasksByIssue.mockResolvedValue([task]);
    mockListTaskMessages.mockResolvedValue([
      { task_id: "task-1", issue_id: "issue-1", seq: 1, type: "tool_use", tool: "transfer_to_agent", input: { agent_name: "Researcher" }, agent_name: "multica_agent" },
      { task_id: "task-1", issue_id: "issue-1", seq: 2, type: "tool_result", tool: "transfer_to_agent", output: '{"result": null}', agent_name: "multica_agent" },
      { task_id: "task-1", issue_id: "issue-1", seq: 3, type: "text", content: "Research output", agent_name: "Researcher" },
    ]);

    render(<TaskRunHistory issueId="issue-1" />);
    await expandHistory();
    await expandTaskEntry();

    await waitFor(() => expect(screen.getByText(/Delegated to/)).toBeInTheDocument());
    expect(screen.queryByText("transfer_to_agent")).not.toBeInTheDocument();
  });
});
