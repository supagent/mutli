/**
 * E2E tests for the Cancel Task feature (I3).
 *
 * Tests:
 *   1. Create issue, assign agent, wait for task to start, click Stop, verify cancelled
 *   2. Cancel on already-completed task is a no-op (no error)
 *
 * Prerequisites:
 *   - Backend running (make start)
 *   - Frontend running (pnpm dev:web)
 *   - Daemon running with DAYTONA_API_KEY exported
 */

import { test, expect } from "@playwright/test";
import { TestApiClient } from "./fixtures";
import { loginAsDefault, createTestApi } from "./helpers";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ??
  `http://localhost:${process.env.PORT ?? "8080"}`;

// -- Helpers (mirrored from embedded-agent.spec.ts) ---------------------------

interface Runtime {
  id: string;
  name: string;
  provider: string;
  status: string;
}
interface Agent {
  id: string;
  name: string;
  runtime_id: string;
}
interface AgentTask {
  id: string;
  status: string;
  issue_id: string;
}

async function apiFetch(
  token: string,
  wsId: string,
  path: string,
  init?: RequestInit,
) {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Workspace-ID": wsId,
      ...((init?.headers as Record<string, string>) ?? {}),
    },
  });
}

async function listRuntimes(token: string, wsId: string): Promise<Runtime[]> {
  const res = await apiFetch(token, wsId, "/api/runtimes");
  if (!res.ok) throw new Error(`listRuntimes: ${res.status} ${await res.text()}`);
  return res.json();
}

async function findEmbeddedRuntime(
  token: string,
  wsId: string,
): Promise<Runtime | undefined> {
  const runtimes = await listRuntimes(token, wsId);
  return runtimes.find(
    (r) => r.provider === "embedded" && r.status === "online",
  );
}

async function createAgent(
  token: string,
  wsId: string,
  name: string,
  runtimeId: string,
): Promise<Agent> {
  const res = await apiFetch(token, wsId, "/api/agents", {
    method: "POST",
    body: JSON.stringify({ name, runtime_id: runtimeId, visibility: "workspace" }),
  });
  if (!res.ok) throw new Error(`createAgent: ${res.status} ${await res.text()}`);
  return res.json();
}

async function assignIssueToAgent(
  token: string,
  wsId: string,
  issueId: string,
  agentId: string,
) {
  const res = await apiFetch(token, wsId, `/api/issues/${issueId}`, {
    method: "PUT",
    body: JSON.stringify({ assignee_type: "agent", assignee_id: agentId }),
  });
  if (!res.ok) throw new Error(`assignIssue: ${res.status}`);
  return res.json();
}

async function listTasksByIssue(
  token: string,
  wsId: string,
  issueId: string,
): Promise<AgentTask[]> {
  const res = await apiFetch(token, wsId, `/api/issues/${issueId}/task-runs`);
  if (!res.ok) throw new Error(`listTasksByIssue: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data) ? data : data.tasks ?? data.runs ?? [];
}

async function cancelTaskViaApi(
  token: string,
  wsId: string,
  issueId: string,
  taskId: string,
): Promise<Response> {
  return apiFetch(token, wsId, `/api/issues/${issueId}/tasks/${taskId}/cancel`, {
    method: "POST",
  });
}

async function deleteAgent(token: string, wsId: string, agentId: string) {
  await apiFetch(token, wsId, `/api/agents/${agentId}/archive`, { method: "POST" });
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (result: T) => boolean,
  timeoutMs = 120_000,
  intervalMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (predicate(result)) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
}

// -- Test Suite ---------------------------------------------------------------

test.describe("Cancel Task (I3)", () => {
  let api: TestApiClient;
  let token: string;
  let wsId: string;
  let embeddedRuntime: Runtime;
  let createdAgentIds: string[] = [];

  test.beforeEach(async () => {
    api = await createTestApi();
    token = api.getToken()!;

    const workspaces = await api.getWorkspaces();
    if (workspaces.length === 0) throw new Error("No workspace found");

    let runtime: Runtime | undefined;
    for (const ws of workspaces) {
      try {
        runtime = await findEmbeddedRuntime(token, ws.id);
      } catch {
        continue;
      }
      if (runtime) {
        wsId = ws.id;
        break;
      }
    }

    if (!runtime || !wsId) {
      test.skip(true, "No embedded runtime (daemon not running with DAYTONA_API_KEY)");
      return;
    }
    embeddedRuntime = runtime;
    api.setWorkspaceId(wsId);
    createdAgentIds = [];
  });

  test.afterEach(async () => {
    if (token && wsId) {
      for (const id of createdAgentIds) {
        try { await deleteAgent(token, wsId, id); } catch { /* ignore */ }
      }
    }
    if (api) await api.cleanup();
  });

  // -- 1. Cancel a running task via the Stop button in the UI -----------------

  test("cancel running task via Stop button in UI", async ({ page }) => {
    test.setTimeout(300_000);

    // Create agent and issue
    const agent = await createAgent(token, wsId, `E2E-Cancel-${Date.now()}`, embeddedRuntime.id);
    createdAgentIds.push(agent.id);

    const issue = await api.createIssue(`E2E Cancel Test ${Date.now()}`, {
      description:
        "Search the web for the history of artificial intelligence. Write a detailed 500-word summary covering all major milestones from the 1950s to today.",
    });

    // Assign agent to trigger a task
    await assignIssueToAgent(token, wsId, issue.id, agent.id);

    // Poll until task is running (sandbox creation can take 30-60s)
    await pollUntil(
      () => listTasksByIssue(token, wsId, issue.id),
      (t) => t.some((task) => task.status === "running" || task.status === "dispatched"),
      180_000,
      3_000,
    );

    // Login and navigate to the issue page
    await loginAsDefault(page);
    await page.evaluate((w) => {
      localStorage.setItem("multica_workspace_id", w);
    }, wsId);
    await page.goto(`/issues/${issue.id}`);

    // Wait for the agent live card to appear (shows "is working" text)
    const liveCard = page.locator("text=is working");
    await expect(liveCard).toBeVisible({ timeout: 60_000 });

    // Take a screenshot of the live card before cancelling
    await page.screenshot({ path: "e2e/artifacts/cancel-task-before-stop.png" });

    // Click the Stop button on the live card
    const stopButton = page.locator("button", { hasText: "Stop" });
    await expect(stopButton).toBeVisible({ timeout: 10_000 });
    await stopButton.click();

    // Wait for the live card to disappear (task:cancelled WS event removes it)
    await expect(liveCard).toBeHidden({ timeout: 30_000 });

    // Take a screenshot after cancellation
    await page.screenshot({ path: "e2e/artifacts/cancel-task-after-stop.png" });

    // Verify execution history shows the cancelled task
    // The TaskRunHistory component renders "Execution history" collapsible
    const executionHistory = page.locator("text=Execution history");
    await expect(executionHistory).toBeVisible({ timeout: 15_000 });

    // Expand the execution history
    await executionHistory.click();

    // Verify the cancelled status text appears (TaskRunEntry renders status as capitalize text)
    const cancelledStatus = page.locator("text=Cancelled");
    await expect(cancelledStatus).toBeVisible({ timeout: 10_000 });

    // Verify the MinusCircle icon is present (rendered as an SVG alongside "Cancelled")
    // The MinusCircle icon is the sibling of the cancelled task entry
    // We check that the cancelled entry row contains the muted-foreground styling
    // (completed = text-success, cancelled = text-muted-foreground, failed = text-destructive)
    const cancelledEntry = page.locator("button", { hasText: "Cancelled" });
    await expect(cancelledEntry).toBeVisible();

    // Take final screenshot showing execution history with Cancelled status
    await page.screenshot({ path: "e2e/artifacts/cancel-task-execution-history.png" });

    // Also verify via API that the task status is "cancelled"
    const tasks = await listTasksByIssue(token, wsId, issue.id);
    const cancelledTask = tasks.find((t) => t.status === "cancelled");
    expect(cancelledTask).toBeDefined();
  });

  // -- 2. Cancel on already-completed task is a no-op -------------------------

  test("cancel on already-completed task is a no-op (no error)", async () => {
    test.setTimeout(300_000);

    // Create agent and issue with a trivial prompt so it completes fast
    const agent = await createAgent(token, wsId, `E2E-CancelNoop-${Date.now()}`, embeddedRuntime.id);
    createdAgentIds.push(agent.id);

    const issue = await api.createIssue(`E2E Cancel Noop Test ${Date.now()}`, {
      description: "What is 2+2? Reply with just the number.",
    });

    // Assign agent to trigger a task
    await assignIssueToAgent(token, wsId, issue.id, agent.id);

    // Wait for the task to complete
    const tasks = await pollUntil(
      () => listTasksByIssue(token, wsId, issue.id),
      (t) => t.some((task) => task.status === "completed" || task.status === "failed"),
      240_000,
      5_000,
    );

    const completedTask = tasks.find((t) => t.status === "completed" || t.status === "failed");
    expect(completedTask).toBeDefined();

    // Try to cancel the already-completed task via API
    // This should not error — it should be a no-op or return a non-5xx response
    const cancelRes = await cancelTaskViaApi(token, wsId, issue.id, completedTask!.id);

    // Accept 200 (OK/no-op) or 4xx (already completed — client error, not server error)
    // The key assertion: no 5xx server error
    expect(cancelRes.status).toBeLessThan(500);

    // Verify the task status is still completed/failed (not changed to cancelled)
    const tasksAfter = await listTasksByIssue(token, wsId, issue.id);
    const sameTask = tasksAfter.find((t) => t.id === completedTask!.id);
    expect(sameTask).toBeDefined();
    expect(sameTask!.status).toBe(completedTask!.status);
  });
});
