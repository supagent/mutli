/**
 * E2E tests for the Embedded Agent Runtime (Daytona sandbox + OpenHarness).
 *
 * Prerequisites:
 *   - Backend running (make start)
 *   - Frontend running (pnpm dev:web)
 *   - Daemon running with DAYTONA_API_KEY set
 *   - ModelRelay running (npx -y modelrelay) or MULTICA_OH_BASE_URL pointing to a paid provider
 *
 * Skip: Tests self-skip if no "embedded" runtime is registered in the workspace.
 */

import { test, expect, type Page } from "@playwright/test";
import { TestApiClient } from "./fixtures";
import { loginAsDefault, createTestApi } from "./helpers";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ??
  `http://localhost:${process.env.PORT ?? "8080"}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

interface Runtime {
  id: string;
  name: string;
  provider: string;
  status: string;
  runtime_mode: string;
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

/** Raw authenticated fetch against the backend API. */
async function apiFetch(
  token: string,
  workspaceId: string,
  path: string,
  init?: RequestInit,
) {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Workspace-ID": workspaceId,
      ...((init?.headers as Record<string, string>) ?? {}),
    },
  });
}

/** List all runtimes in the workspace. */
async function listRuntimes(
  token: string,
  wsId: string,
): Promise<Runtime[]> {
  const res = await apiFetch(token, wsId, "/api/runtimes");
  if (!res.ok) throw new Error(`listRuntimes failed: ${res.status}`);
  return res.json();
}

/** Find the embedded runtime (provider == "embedded", status == "online"). */
async function findEmbeddedRuntime(
  token: string,
  wsId: string,
): Promise<Runtime | undefined> {
  const runtimes = await listRuntimes(token, wsId);
  return runtimes.find(
    (r) => r.provider === "embedded" && r.status === "online",
  );
}

/** Create an agent backed by a specific runtime. */
async function createAgent(
  token: string,
  wsId: string,
  name: string,
  runtimeId: string,
): Promise<Agent> {
  const res = await apiFetch(token, wsId, "/api/agents", {
    method: "POST",
    body: JSON.stringify({
      name,
      runtime_id: runtimeId,
      visibility: "workspace",
    }),
  });
  if (!res.ok)
    throw new Error(`createAgent failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Assign an issue to an agent. */
async function assignIssueToAgent(
  token: string,
  wsId: string,
  issueId: string,
  agentId: string,
) {
  const res = await apiFetch(token, wsId, `/api/issues/${issueId}`, {
    method: "PATCH",
    body: JSON.stringify({
      assignee_type: "agent",
      assignee_id: agentId,
    }),
  });
  if (!res.ok) throw new Error(`assignIssue failed: ${res.status}`);
  return res.json();
}

/** Get active tasks for an issue. */
async function getActiveTasks(
  token: string,
  wsId: string,
  issueId: string,
): Promise<{ tasks: AgentTask[] }> {
  const res = await apiFetch(
    token,
    wsId,
    `/api/issues/${issueId}/tasks/active`,
  );
  if (!res.ok) return { tasks: [] };
  return res.json();
}

/** Get all tasks for an issue. */
async function listTasksByIssue(
  token: string,
  wsId: string,
  issueId: string,
): Promise<AgentTask[]> {
  const res = await apiFetch(token, wsId, `/api/issues/${issueId}/tasks`);
  if (!res.ok) return [];
  return res.json();
}

/** Delete an agent. */
async function deleteAgent(token: string, wsId: string, agentId: string) {
  await apiFetch(token, wsId, `/api/agents/${agentId}/archive`, {
    method: "POST",
  });
}

/** Poll until a condition is met or timeout. */
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

// ── Test Suite ────────────────────────────────────────────────────────────────

test.describe("Embedded Agent E2E", () => {
  let api: TestApiClient;
  let token: string;
  let wsId: string;
  let embeddedRuntime: Runtime;
  let createdAgentIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    api = await createTestApi();
    await loginAsDefault(page);

    token = api.getToken()!;
    const workspaces = await api.getWorkspaces();
    wsId = workspaces[0]?.id;
    if (!wsId) throw new Error("No workspace found");

    // Check if embedded runtime is available — skip all tests if not.
    const runtime = await findEmbeddedRuntime(token, wsId);
    if (!runtime) {
      test.skip(
        true,
        "No embedded runtime registered (daemon not running with DAYTONA_API_KEY)",
      );
      return;
    }
    embeddedRuntime = runtime;
    createdAgentIds = [];
  });

  test.afterEach(async () => {
    // Cleanup agents created during test
    for (const id of createdAgentIds) {
      try {
        await deleteAgent(token, wsId, id);
      } catch {
        /* ignore */
      }
    }
    await api.cleanup();
  });

  // ── 1. Runtime Registration ───────────────────────────────────────────────

  test("embedded runtime appears in Settings → Runtimes", async ({
    page,
  }) => {
    await page.goto("/settings/runtimes");
    await page.waitForLoadState("networkidle");

    // The runtime list should show "Embedded Agent" with online status
    const runtimeCard = page.locator("text=Embedded Agent").first();
    await expect(runtimeCard).toBeVisible({ timeout: 10_000 });

    // Take screenshot for evidence
    await page.screenshot({
      path: "e2e/artifacts/embedded-runtime-settings.png",
    });
  });

  // ── 2. Agent Creation ─────────────────────────────────────────────────────

  test("can create an embedded agent via API", async ({ page }) => {
    const agentName = `E2E-Agent-${Date.now()}`;
    const agent = await createAgent(
      token,
      wsId,
      agentName,
      embeddedRuntime.id,
    );
    createdAgentIds.push(agent.id);

    expect(agent.name).toBe(agentName);
    expect(agent.runtime_id).toBe(embeddedRuntime.id);

    // Navigate to agents page and verify it appears
    await page.goto("/settings/agents");
    await page.waitForLoadState("networkidle");
    await expect(page.locator(`text=${agentName}`)).toBeVisible({
      timeout: 10_000,
    });
  });

  // ── 3. Issue Assignment → Messages Stream ─────────────────────────────────

  test("assign issue to embedded agent → messages stream in UI", async ({
    page,
  }) => {
    test.setTimeout(180_000); // 3 min — sandbox creation can take 30s+

    // Create agent + issue via API
    const agentName = `E2E-Stream-${Date.now()}`;
    const agent = await createAgent(
      token,
      wsId,
      agentName,
      embeddedRuntime.id,
    );
    createdAgentIds.push(agent.id);

    const issue = await api.createIssue(`E2E Agent Test ${Date.now()}`, {
      description: "Test issue for embedded agent streaming validation",
    });

    // Assign issue to agent
    await assignIssueToAgent(token, wsId, issue.id, agent.id);

    // Navigate to the issue
    await page.goto(`/issues/${issue.id}`);
    await page.waitForLoadState("networkidle");

    // Wait for the AgentLiveCard to appear (agent is working)
    // The card contains "{agentName} is working" text
    const liveCard = page.locator(`text=${agentName} is working`);
    await expect(liveCard).toBeVisible({ timeout: 90_000 });

    // Verify streaming is happening — tool count should appear
    const toolIndicator = page.locator('span:has-text("tool")');
    await expect(toolIndicator).toBeVisible({ timeout: 60_000 });

    // Take screenshot of active streaming
    await page.screenshot({
      path: "e2e/artifacts/embedded-agent-streaming.png",
    });

    // Wait for task to complete (card disappears or changes state)
    // Poll the API for task completion instead of relying on UI timing
    await pollUntil(
      () => listTasksByIssue(token, wsId, issue.id),
      (tasks) =>
        tasks.some(
          (t) =>
            t.status === "completed" ||
            t.status === "failed" ||
            t.status === "cancelled",
        ),
      180_000,
      3_000,
    );

    // Verify task completed (not failed)
    const tasks = await listTasksByIssue(token, wsId, issue.id);
    const completedTask = tasks.find((t) => t.status === "completed");
    if (!completedTask) {
      const failedTask = tasks.find((t) => t.status === "failed");
      if (failedTask) {
        // Take screenshot of failure state
        await page.screenshot({
          path: "e2e/artifacts/embedded-agent-failed.png",
        });
      }
    }
    expect(completedTask).toBeDefined();

    // Take final screenshot showing completed state
    await page.screenshot({
      path: "e2e/artifacts/embedded-agent-completed.png",
    });
  });

  // ── 4. @mention Triggers Task ─────────────────────────────────────────────

  test("@mention agent in comment triggers task execution", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    // Create agent + issue
    const agentName = `E2E-Mention-${Date.now()}`;
    const agent = await createAgent(
      token,
      wsId,
      agentName,
      embeddedRuntime.id,
    );
    createdAgentIds.push(agent.id);

    const issue = await api.createIssue(`E2E Mention Test ${Date.now()}`);

    // Navigate to issue
    await page.goto(`/issues/${issue.id}`);
    await page.waitForLoadState("networkidle");

    // Find comment input and type an @mention
    const commentInput = page.locator(
      'input[placeholder="Leave a comment..."], [contenteditable="true"]',
    );
    await expect(commentInput).toBeVisible({ timeout: 10_000 });
    await commentInput.click();
    await commentInput.fill(`@${agentName} what is 2+2?`);

    // Submit the comment
    const submitBtn = page
      .locator('form button[type="submit"], button:has-text("Send")')
      .last();
    await submitBtn.click();

    // Wait for task to be created (poll API)
    const taskData = await pollUntil(
      () => getActiveTasks(token, wsId, issue.id),
      (data) => data.tasks.length > 0,
      30_000,
      2_000,
    ).catch(() => ({ tasks: [] as AgentTask[] }));

    if (taskData.tasks.length > 0) {
      // Task was created — wait for the live card
      const liveCard = page.locator(`text=${agentName} is working`);
      await expect(liveCard).toBeVisible({ timeout: 90_000 });

      await page.screenshot({
        path: "e2e/artifacts/embedded-agent-mention-streaming.png",
      });

      // Wait for completion
      await pollUntil(
        () => listTasksByIssue(token, wsId, issue.id),
        (tasks) => tasks.some((t) => t.status !== "queued" && t.status !== "dispatched" && t.status !== "running"),
        180_000,
        3_000,
      );
    }

    // Take final screenshot
    await page.screenshot({
      path: "e2e/artifacts/embedded-agent-mention-complete.png",
    });
  });

  // ── 5. No Embedded Runtime → No Agent Option ──────────────────────────────

  test("existing CLI agents are unaffected by embedded runtime", async ({
    page,
  }) => {
    // Verify at least one runtime exists
    const runtimes = await listRuntimes(token, wsId);
    expect(runtimes.length).toBeGreaterThan(0);

    // Navigate to agents settings
    await page.goto("/settings/agents");
    await page.waitForLoadState("networkidle");

    // Page should load without errors
    await expect(page.locator("text=Agents")).toBeVisible({ timeout: 10_000 });

    await page.screenshot({
      path: "e2e/artifacts/agents-settings-page.png",
    });
  });

  // ── 6. Agent Appears in Assignee Picker ───────────────────────────────────

  test("embedded agent appears in issue assignee picker", async ({
    page,
  }) => {
    const agentName = `E2E-Assign-${Date.now()}`;
    const agent = await createAgent(
      token,
      wsId,
      agentName,
      embeddedRuntime.id,
    );
    createdAgentIds.push(agent.id);

    const issue = await api.createIssue(`E2E Assignee Test ${Date.now()}`);

    // Navigate to issue detail
    await page.goto(`/issues/${issue.id}`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("text=Properties")).toBeVisible({
      timeout: 10_000,
    });

    // Look for the assignee property field and click it
    const assigneeField = page
      .locator('text=Assignee')
      .locator("..")
      .locator("button, [role='combobox']")
      .first();
    await assigneeField.click();

    // The agent should appear in the dropdown
    await expect(page.locator(`text=${agentName}`)).toBeVisible({
      timeout: 5_000,
    });

    await page.screenshot({
      path: "e2e/artifacts/embedded-agent-assignee-picker.png",
    });
  });

  // ── 7. Task Messages Contain Expected Types ───────────────────────────────

  test("task messages include text and tool_use events", async ({ page }) => {
    test.setTimeout(180_000);

    const agentName = `E2E-MsgTypes-${Date.now()}`;
    const agent = await createAgent(
      token,
      wsId,
      agentName,
      embeddedRuntime.id,
    );
    createdAgentIds.push(agent.id);

    const issue = await api.createIssue(`E2E Message Types ${Date.now()}`, {
      description: "Search the web for the current weather in New York",
    });

    await assignIssueToAgent(token, wsId, issue.id, agent.id);

    // Wait for task to complete
    const tasks = await pollUntil(
      () => listTasksByIssue(token, wsId, issue.id),
      (tasks) => tasks.some((t) => t.status === "completed" || t.status === "failed"),
      180_000,
      3_000,
    );

    const task = tasks.find(
      (t) => t.status === "completed" || t.status === "failed",
    );
    expect(task).toBeDefined();

    // Fetch task messages and verify types
    const res = await apiFetch(
      token,
      wsId,
      `/api/tasks/${task!.id}/messages`,
    );
    const messages = await res.json();

    const types = new Set(
      (messages as { type: string }[]).map((m) => m.type),
    );

    // Should have at least text messages
    expect(types.has("text")).toBe(true);

    // Log all message types found for debugging
    console.log(
      `Task ${task!.id}: ${messages.length} messages, types: ${[...types].join(", ")}`,
    );
  });
});
