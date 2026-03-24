# CLAUDE.md

This file gives coding agents high-signal guidance for this repository.

## 1. Project Context

Multica is an AI-native task management platform — like Linear, but with AI agents as first-class citizens.

- Agents can be assigned issues, create issues, comment, and change status
- Supports local (daemon) and cloud agent runtimes
- Built for 2-10 person AI-native teams

## 2. Architecture

**Polyglot monorepo** — Go backend + TypeScript frontend.

- `server/` — Go backend (Chi + sqlc + gorilla/websocket)
- `apps/web/` — Next.js 16 frontend
- `packages/` — Shared TypeScript packages (ui, types, sdk, store, hooks, utils)

## 3. Core Workflow Commands

```bash
# One-click setup & run
make setup            # First-time: install deps, start DB, migrate
make seed             # Optional: load example data
make start            # Start backend + frontend together
make stop             # Stop everything

# Frontend
pnpm install
pnpm dev:web          # Next.js dev server (port 3000)
pnpm build            # Build all TS packages
pnpm typecheck        # TypeScript check
pnpm test             # TS tests (Vitest)

# Backend (Go)
make dev              # Run Go server (port 8080)
make daemon           # Run local daemon
make test             # Go tests
make sqlc             # Regenerate sqlc code
make migrate-up       # Run database migrations
make migrate-down     # Rollback migrations
make seed             # Seed example data

# Infrastructure
docker compose up -d  # Start PostgreSQL
docker compose down   # Stop PostgreSQL
```

## 4. Coding Rules

- TypeScript strict mode is enabled; keep types explicit.
- Go code follows standard Go conventions (gofmt, go vet).
- Keep comments in code **English only**.
- Prefer existing patterns/components over introducing parallel abstractions.
- Unless the user explicitly asks for backwards compatibility, do **not** add compatibility layers, fallback paths, dual-write logic, legacy adapters, or temporary shims.
- If a flow or API is being replaced and the product is not yet live, prefer removing the old path instead of preserving both old and new behavior.
- Treat compatibility code as a maintenance cost, not a default safety mechanism. Avoid "just in case" branches that make the codebase harder to reason about.
- Avoid broad refactors unless required by the task.

## 5. UI/UX Rules

- Prefer `packages/ui` shadcn components over custom implementations.
- Do not introduce extra state (useState, context, reducers) unless explicitly required by the design.
- Pay close attention to **overflow** (truncate long text, scrollable containers), **alignment**, and **spacing** consistency.
- When unsure about interaction or state design, ask — the user will provide direction.

## 6. Testing Rules

- **TypeScript**: Vitest. Mock external/third-party dependencies only.
- **Go**: Standard `go test`. Use testcontainers or test database for DB tests.

## 7. Commit Rules

- Use atomic commits grouped by logical intent.
- Conventional format:
  - `feat(scope): ...`
  - `fix(scope): ...`
  - `refactor(scope): ...`
  - `docs: ...`
  - `test(scope): ...`
  - `chore(scope): ...`

## 8. Minimum Pre-Push Checks

```bash
make check    # Runs all checks: typecheck, unit tests, Go tests, E2E
```

For individual checks during development:
```bash
pnpm typecheck        # TypeScript type errors only
pnpm test             # TS unit tests only (Vitest)
make test             # Go tests only
pnpm exec playwright test   # E2E only (requires backend + frontend running)
```

## 9. AI Agent Verification Loop

After writing or modifying code, always run the full verification pipeline:

```bash
make check
```

This runs all checks in sequence:
1. TypeScript typecheck (`pnpm typecheck`)
2. TypeScript unit tests (`pnpm test`)
3. Go tests (`go test ./...`)
4. E2E tests (auto-starts backend + frontend if needed, runs Playwright)

**Workflow:**
- Write code to satisfy the requirement
- Run `make check`
- If any step fails, read the error output, fix the code, and re-run `make check`
- Repeat until all checks pass
- Only then consider the task complete

**Quick iteration:** If you know only TypeScript or Go is affected, run individual checks first for faster feedback, then finish with a full `make check` before marking work complete.

## 10. E2E Test Patterns

E2E tests should be self-contained. Use the `TestApiClient` fixture for data setup/teardown:

```typescript
import { loginAsDefault, createTestApi } from "./helpers";
import type { TestApiClient } from "./fixtures";

let api: TestApiClient;

test.beforeEach(async ({ page }) => {
  api = await createTestApi();       // logged-in API client
  await loginAsDefault(page);        // browser session
});

test.afterEach(async () => {
  await api.cleanup();               // delete any data created during the test
});

test("example", async ({ page }) => {
  const issue = await api.createIssue("Test Issue");  // create via API
  await page.goto(`/issues/${issue.id}`);             // test via UI
  // api.cleanup() in afterEach removes the issue
});
```
