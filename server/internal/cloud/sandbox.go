package cloud

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/daytonaio/daytona/libs/sdk-go/pkg/daytona"
	"github.com/daytonaio/daytona/libs/sdk-go/pkg/options"
	"github.com/daytonaio/daytona/libs/sdk-go/pkg/types"
	"github.com/multica-ai/multica/server/pkg/agent"
)

const (
	defaultModel        = "auto-fastest"
	defaultMaxTurns     = 25
	defaultLLMBaseURL   = "http://localhost:7352/v1"
	defaultLLMAPIKey    = "dummy"
	defaultTimeout      = 20 * time.Minute
	defaultImageTimeout = 8 * time.Minute // larger: installs Node.js + ModelRelay + OH
	ohVersion           = "0.1.6"

	// Free fallback model on OpenRouter (used when ModelRelay fails to start).
	// Must support tool calling. See: https://openrouter.ai/models?pricing=free
	openRouterFreeModel = "google/gemma-4-31b-it:free"
	openRouterBaseURL   = "https://openrouter.ai/api/v1"
)

// Denied tools config for knowledge worker mode.
var deniedToolsJSON = `{
	"permission": {
		"mode": "full_auto",
		"denied_tools": ["agent", "ask_user_question", "bash", "brief", "config", "cron_create", "cron_delete", "cron_list", "cron_toggle", "enter_plan_mode", "enter_worktree", "exit_plan_mode", "exit_worktree", "file_edit", "file_read", "glob", "grep", "list_mcp_resources", "lsp", "mcp_auth", "mcp", "notebook_edit", "read_mcp_resource", "remote_trigger", "send_message", "skill", "sleep", "task_create", "task_get", "task_list", "task_output", "task_stop", "task_update", "team_create", "team_delete", "todo_write", "tool_search"]
	}
}`

// Research-first CLAUDE.md instructions.
var researchInstructions = `# Research-First Agent Rules

## MANDATORY: Research Before Writing

You MUST use web_search to gather real data BEFORE writing any output file. This is non-negotiable.

### Hard Rules

1. **NEVER generate reports from training data alone.** Your training data is stale. Every factual claim MUST come from a web search performed during this session.
2. **Search first, write last.** Before calling write_file, you must have called web_search at least 3 times.
3. **Cite sources.** Every factual claim must include the source URL.
4. **Use web_fetch to read full pages** when a search snippet is insufficient.
5. **No hallucinated data.** If you cannot find a source, say "data not publicly available."

### Output Location

Write all output files to /workspace/output/.
`

// SandboxManager manages Daytona sandbox lifecycle for embedded agent execution.
type SandboxManager struct {
	cfg    SandboxConfig
	client *daytona.Client
	logger *slog.Logger
}

// NewSandboxManager creates a SandboxManager with the given config.
func NewSandboxManager(cfg SandboxConfig, logger *slog.Logger) (*SandboxManager, error) {
	if cfg.DaytonaAPIKey == "" {
		return nil, fmt.Errorf("DAYTONA_API_KEY is required")
	}

	dcfg := &types.DaytonaConfig{APIKey: cfg.DaytonaAPIKey}
	if cfg.DaytonaAPIURL != "" {
		dcfg.APIUrl = cfg.DaytonaAPIURL
	}

	client, err := daytona.NewClientWithConfig(dcfg)
	if err != nil {
		return nil, fmt.Errorf("init daytona client: %w", err)
	}

	return &SandboxManager{cfg: cfg, client: client, logger: logger}, nil
}

// Close shuts down the Daytona client.
func (sm *SandboxManager) Close(ctx context.Context) {
	sm.client.Close(ctx)
}

// Execute runs an OpenHarness agent inside a Daytona sandbox, returning
// a Session with streaming messages and a final result.
// Implements agent.SandboxExecutor.
func (sm *SandboxManager) Execute(ctx context.Context, cfg agent.SandboxTaskConfig) (*agent.Session, error) {
	taskCfg := TaskExecConfig{
		TaskID:       cfg.TaskID,
		Prompt:       cfg.Prompt,
		Model:        cfg.Model,
		MaxTurns:     cfg.MaxTurns,
		SystemPrompt: cfg.SystemPrompt,
		Timeout:      cfg.Timeout,
	}
	return sm.execute(ctx, taskCfg)
}

func (sm *SandboxManager) execute(ctx context.Context, taskCfg TaskExecConfig) (*agent.Session, error) {
	timeout := taskCfg.Timeout
	if timeout == 0 {
		timeout = defaultTimeout
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)

	// Resolve config defaults
	model := taskCfg.Model
	if model == "" {
		model = sm.cfg.DefaultModel
	}
	if model == "" {
		model = defaultModel
	}
	maxTurns := taskCfg.MaxTurns
	if maxTurns == 0 {
		maxTurns = sm.cfg.DefaultMaxTurns
	}
	if maxTurns == 0 {
		maxTurns = defaultMaxTurns
	}
	baseURL := sm.cfg.LLMBaseURL
	if baseURL == "" {
		baseURL = defaultLLMBaseURL
	}
	apiKey := sm.cfg.LLMAPIKey
	if apiKey == "" {
		apiKey = defaultLLMAPIKey
	}

	// Build sandbox image: Python (OH) + Node.js (ModelRelay)
	image := daytona.DebianSlim(nil).
		AptGet([]string{"nodejs", "npm", "curl"}).
		Run("npm install -g modelrelay").
		PipInstall([]string{fmt.Sprintf("openharness-ai==%s", ohVersion)}).
		Env("TERM", "dumb")

	imageTimeout := sm.cfg.ImageTimeout
	if imageTimeout == 0 {
		imageTimeout = defaultImageTimeout
	}

	// Resolve OpenRouter fallback key
	openRouterKey := sm.cfg.OpenRouterAPIKey

	// Create sandbox with env vars for both ModelRelay and OpenRouter fallback
	sm.logger.Info("creating sandbox", "task", taskCfg.TaskID, "model", model)
	envVars := map[string]string{
		"TERM":                   "dumb",
		"OPENHARNESS_CONFIG_DIR": "/etc/multica-agent",
	}
	if openRouterKey != "" {
		envVars["OPENROUTER_API_KEY"] = openRouterKey
	}

	sandbox, err := sm.client.Create(runCtx, types.ImageParams{
		SandboxBaseParams: types.SandboxBaseParams{
			EnvVars: envVars,
		},
		Image: image,
	}, options.WithTimeout(imageTimeout))
	if err != nil {
		cancel()
		return nil, fmt.Errorf("create sandbox: %w", err)
	}
	sm.logger.Info("sandbox created", "task", taskCfg.TaskID, "sandbox", sandbox.ID)

	// Upload config files — fail closed if denied_tools can't be enforced.
	if err := sandbox.FileSystem.UploadFile(runCtx, []byte(deniedToolsJSON), "/etc/multica-agent/settings.json"); err != nil {
		cleanupSandbox(sandbox, sm.logger)
		cancel()
		return nil, fmt.Errorf("upload denied_tools config: %w (sandbox would run without safety restrictions)", err)
	}
	if err := sandbox.FileSystem.UploadFile(runCtx, []byte(researchInstructions), "/home/daytona/CLAUDE.md"); err != nil {
		sm.logger.Warn("failed to upload CLAUDE.md (non-fatal)", "error", err)
	}

	// Create output directory
	sandbox.Process.ExecuteCommand(runCtx, "mkdir -p /workspace/output")

	// Create PTY session
	sessionID := fmt.Sprintf("task-%s", taskCfg.TaskID)
	handle, err := sandbox.Process.CreatePty(runCtx, sessionID)
	if err != nil {
		cleanupSandbox(sandbox, sm.logger)
		cancel()
		return nil, fmt.Errorf("create pty: %w", err)
	}
	if err := handle.WaitForConnection(runCtx); err != nil {
		cleanupSandbox(sandbox, sm.logger)
		cancel()
		return nil, fmt.Errorf("pty connect: %w", err)
	}

	// Upload the entrypoint script that starts ModelRelay with fallback.
	entrypoint := buildEntrypointScript(taskCfg.Prompt, model, maxTurns, taskCfg.SystemPrompt)
	if err := sandbox.FileSystem.UploadFile(runCtx, []byte(entrypoint), "/tmp/run-agent.sh"); err != nil {
		handle.Disconnect()
		cleanupSandbox(sandbox, sm.logger)
		cancel()
		return nil, fmt.Errorf("upload entrypoint: %w", err)
	}
	sandbox.Process.ExecuteCommand(runCtx, "chmod +x /tmp/run-agent.sh")

	sm.logger.Info("running agent in sandbox", "task", taskCfg.TaskID, "model", model)

	// Execute the entrypoint script via PTY
	if _, err := handle.Write([]byte("/tmp/run-agent.sh\nexit\n")); err != nil {
		handle.Disconnect()
		cleanupSandbox(sandbox, sm.logger)
		cancel()
		return nil, fmt.Errorf("write to pty: %w", err)
	}

	// Create channels
	msgCh := make(chan agent.Message, 256)
	resCh := make(chan agent.Result, 1)

	// Drain PTY output in background
	go func() {
		defer cancel()
		defer close(resCh)

		startTime := time.Now()
		var output strings.Builder
		finalStatus := "completed"
		var finalError string

		// Drain PTY data with context awareness (respects timeout/cancel).
		drainPTYData(runCtx, handle.DataChan(), msgCh, &output)
		close(msgCh)

		handle.Disconnect()
		duration := time.Since(startTime)

		if runCtx.Err() == context.DeadlineExceeded {
			finalStatus = "timeout"
			finalError = fmt.Sprintf("sandbox timed out after %s", timeout)
		} else if runCtx.Err() == context.Canceled {
			finalStatus = "aborted"
			finalError = "execution cancelled"
		}

		sm.logger.Info("sandbox task finished", "task", taskCfg.TaskID, "status", finalStatus, "duration", duration.Round(time.Millisecond))

		// Cleanup sandbox
		cleanupSandbox(sandbox, sm.logger)

		resCh <- agent.Result{
			Status:     finalStatus,
			Output:     output.String(),
			Error:      finalError,
			DurationMs: duration.Milliseconds(),
		}
	}()

	return &agent.Session{Messages: msgCh, Result: resCh}, nil
}

// drainPTYData reads from a PTY data channel, buffers partial lines,
// parses complete lines via ParseOHLine, and sends messages to msgCh.
// It also accumulates text output in the provided builder.
// Respects context cancellation to avoid blocking indefinitely.
func drainPTYData(ctx context.Context, dataCh <-chan []byte, msgCh chan<- agent.Message, output *strings.Builder) {
	var lineBuf strings.Builder
	for {
		select {
		case <-ctx.Done():
			return
		case data, ok := <-dataCh:
			if !ok {
				// Channel closed — flush remaining
				if remaining := strings.TrimSpace(lineBuf.String()); remaining != "" {
					if msg, ok := ParseOHLine(remaining); ok {
						if msg.Type == agent.MessageText {
							output.WriteString(msg.Content)
						}
						trySendCloud(msgCh, msg)
					}
				}
				return
			}
			lineBuf.Write(data)
			for {
				full := lineBuf.String()
				idx := strings.Index(full, "\n")
				if idx < 0 {
					break
				}
				line := full[:idx]
				lineBuf.Reset()
				lineBuf.WriteString(full[idx+1:])
				if msg, ok := ParseOHLine(line); ok {
					if msg.Type == agent.MessageText {
						output.WriteString(msg.Content)
					}
					trySendCloud(msgCh, msg)
				}
			}
		}
	}
}

// shellQuote wraps a string in single quotes for safe shell interpolation.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

// buildEntrypointScript creates a bash script that:
// 1. Starts ModelRelay in background
// 2. Health-checks ModelRelay
// 3. Falls back to OpenRouter free model if ModelRelay fails
// 4. Runs OH with the resolved provider
func buildEntrypointScript(prompt, model string, maxTurns int, systemPrompt string) string {
	ohArgs := fmt.Sprintf(`-p %s --output-format stream-json --api-format openai --max-turns %d --permission-mode full_auto --bare`,
		shellQuote(prompt), maxTurns)
	if systemPrompt != "" {
		ohArgs += " --append-system-prompt " + shellQuote(systemPrompt)
	}

	return fmt.Sprintf(`#!/bin/bash
set -e

# --- Phase 1: Start ModelRelay ---
modelrelay > /dev/null 2>&1 &
MR_PID=$!

# --- Phase 2: Wait for ModelRelay (up to 30s) ---
MR_READY=false
for i in $(seq 1 30); do
  if curl -sf http://localhost:7352/v1/models > /dev/null 2>&1; then
    MR_READY=true
    break
  fi
  sleep 1
done

if [ "$MR_READY" = "true" ]; then
  echo '{"type":"system","message":"Using ModelRelay (free)"}'
  BASE_URL="http://localhost:7352/v1"
  API_KEY="dummy"
  MODEL=%s
else
  kill $MR_PID 2>/dev/null || true
  # --- Phase 3: Fallback to OpenRouter free model ---
  if [ -n "$OPENROUTER_API_KEY" ]; then
    echo '{"type":"system","message":"ModelRelay unavailable, falling back to OpenRouter free model"}'
    BASE_URL="%s"
    API_KEY="$OPENROUTER_API_KEY"
    MODEL="%s"
  else
    echo '{"type":"error","message":"No LLM provider available: ModelRelay failed to start and OPENROUTER_API_KEY not set","recoverable":false}'
    exit 1
  fi
fi

# --- Phase 4: Run OpenHarness ---
export OPENAI_API_KEY="$API_KEY"
oh %s --base-url "$BASE_URL" --api-key "$API_KEY" --model "$MODEL" 2>/dev/null

# Cleanup
kill $MR_PID 2>/dev/null || true
`, shellQuote(model), openRouterBaseURL, openRouterFreeModel, ohArgs)
}

func trySendCloud(ch chan<- agent.Message, msg agent.Message) {
	select {
	case ch <- msg:
	default:
	}
}

func cleanupSandbox(sandbox *daytona.Sandbox, logger *slog.Logger) {
	cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cleanupCancel()
	if err := sandbox.Delete(cleanupCtx); err != nil {
		logger.Warn("failed to delete sandbox", "id", sandbox.ID, "error", err)
	} else {
		logger.Info("sandbox deleted", "id", sandbox.ID)
	}
}
