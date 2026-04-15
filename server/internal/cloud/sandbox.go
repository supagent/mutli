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

// researchInstructions is the CLAUDE.md uploaded to the sandbox working directory.
// It overrides the default OH coding-assistant identity.
var researchInstructions = `# Agent Identity

You are a **research and knowledge agent**, NOT a coding assistant. You do NOT write code, run shell commands, or edit files. You research topics using the web and deliver findings as structured reports.

## Your Tools

You have exactly THREE tools. Do not attempt to use any others:

1. **web_search** — Search the internet for information. Use this FIRST for every task.
2. **web_fetch** — Read the full text of a webpage. Use this to get details from search results.
3. **write_file** — Write your findings to a file. Write to /workspace/output/.

All other tools (bash, glob, grep, read_file, file_edit, etc.) are DISABLED and will be denied if you try them.

## How to Work

1. Read the task description in your prompt carefully.
2. Use web_search to find relevant information (at least 3 searches).
3. Use web_fetch to read important pages in full.
4. Synthesize your findings into a clear, structured response.
5. If the task asks for a file (CSV, report), use write_file to create it in /workspace/output/.

## Rules

- NEVER try to run bash commands, read local files, or use coding tools.
- NEVER generate data from memory — every fact must come from a web search in this session.
- ALWAYS cite sources with URLs.
- If you cannot find information, say "data not publicly available" rather than guessing.
- Respond conversationally with your findings. The user sees your text output directly.
`

// knowledgeAgentSystemPrompt is appended to OH's system prompt via --append-system-prompt.
// It reinforces the agent identity since OH's default prompt says "coding assistant."
var knowledgeAgentSystemPrompt = `IMPORTANT OVERRIDE: Ignore any prior instructions about being a "coding assistant" or helping with "software engineering tasks." You are a RESEARCH AGENT. Your only job is to search the web, read pages, and report findings. You have three tools: web_search, web_fetch, and write_file. All other tools are disabled. Do not attempt bash, glob, grep, read_file, or any coding tools — they will be denied. Start every task by searching the web.`

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

	// Create message channel early so we can send lifecycle status updates.
	msgCh := make(chan agent.Message, 256)

	trySendCloud(msgCh, agent.Message{Type: agent.MessageText, Content: "Creating sandbox environment..."})

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
	trySendCloud(msgCh, agent.Message{Type: agent.MessageText, Content: "Sandbox ready. Configuring agent..."})

	// Upload config files — fail closed if denied_tools can't be enforced.
	// Write to BOTH the custom config dir AND OH's default location (~/.openharness/settings.json)
	// to ensure denied_tools is loaded regardless of whether OPENHARNESS_CONFIG_DIR propagates to PTY.
	sandbox.Process.ExecuteCommand(runCtx, "mkdir -p /home/daytona/.openharness")
	if err := sandbox.FileSystem.UploadFile(runCtx, []byte(deniedToolsJSON), "/home/daytona/.openharness/settings.json"); err != nil {
		cleanupSandbox(sandbox, sm.logger)
		cancel()
		return nil, fmt.Errorf("upload denied_tools config: %w (sandbox would run without safety restrictions)", err)
	}
	// Also write to OPENHARNESS_CONFIG_DIR location as belt-and-suspenders.
	sandbox.FileSystem.UploadFile(runCtx, []byte(deniedToolsJSON), "/etc/multica-agent/settings.json")

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

	trySendCloud(msgCh, agent.Message{Type: agent.MessageText, Content: "Starting research agent (this may take a moment)..."})
	sm.logger.Info("running agent in sandbox", "task", taskCfg.TaskID, "model", model)

	// Execute the entrypoint script via PTY
	if _, err := handle.Write([]byte("/tmp/run-agent.sh\nexit\n")); err != nil {
		handle.Disconnect()
		cleanupSandbox(sandbox, sm.logger)
		cancel()
		close(msgCh)
		return nil, fmt.Errorf("write to pty: %w", err)
	}

	// Result channel (msgCh already created above for lifecycle messages).
	resCh := make(chan agent.Result, 1)

	// Drain PTY output in background
	go func() {
		defer cancel()
		defer close(resCh)

		startTime := time.Now()
		var textOutput strings.Builder
		var toolOutput strings.Builder
		finalStatus := "completed"
		var finalError string

		// Drain PTY data with context awareness (respects timeout/cancel).
		drainPTYData(runCtx, handle.DataChan(), msgCh, &textOutput, &toolOutput)
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

		// Use text output if available, fall back to tool output summary.
		finalOutput := textOutput.String()
		if finalOutput == "" && toolOutput.Len() > 0 {
			finalOutput = toolOutput.String()
		}

		sm.logger.Info("sandbox task finished", "task", taskCfg.TaskID, "status", finalStatus,
			"duration", duration.Round(time.Millisecond),
			"textLen", textOutput.Len(), "toolOutputLen", toolOutput.Len())

		// Cleanup sandbox
		cleanupSandbox(sandbox, sm.logger)

		resCh <- agent.Result{
			Status:     finalStatus,
			Output:     finalOutput,
			Error:      finalError,
			DurationMs: duration.Milliseconds(),
		}
	}()

	return &agent.Session{Messages: msgCh, Result: resCh}, nil
}

// drainPTYData reads from a PTY data channel, buffers partial lines,
// parses complete lines via ParseOHLine, and sends messages to msgCh.
// Accumulates assistant text in textOutput and tool results in toolOutput (fallback).
// Respects context cancellation to avoid blocking indefinitely.
func drainPTYData(ctx context.Context, dataCh <-chan []byte, msgCh chan<- agent.Message, textOutput, toolOutput *strings.Builder) {
	processMsg := func(msg agent.Message) {
		switch msg.Type {
		case agent.MessageText:
			textOutput.WriteString(msg.Content)
		case agent.MessageToolResult:
			if msg.Output != "" {
				toolOutput.WriteString(msg.Output)
				toolOutput.WriteByte('\n')
			}
		}
		trySendCloud(msgCh, msg)
	}

	var lineBuf strings.Builder
	for {
		select {
		case <-ctx.Done():
			return
		case data, ok := <-dataCh:
			if !ok {
				if remaining := strings.TrimSpace(lineBuf.String()); remaining != "" {
					if msg, ok := ParseOHLine(remaining); ok {
						processMsg(msg)
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
					processMsg(msg)
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
	// Wrap the user's task in explicit identity + instructions.
	// This goes in the -p prompt itself (not --append-system-prompt) because
	// the default OH system prompt says "coding assistant" and the model
	// follows that over appended overrides.
	wrappedPrompt := fmt.Sprintf(`You are a RESEARCH AGENT. You are NOT a coding assistant. Do NOT use bash, glob, grep, read_file, or any coding tools — they are all disabled and will be denied.

You have ONLY these 3 tools:
- web_search: Search the internet. IMPORTANT: DuckDuckGo (default) may be blocked. If web_search fails, use web_fetch with a search URL instead.
- web_fetch: Read a webpage. You can also use this to search by fetching: https://html.duckduckgo.com/html/?q=YOUR+QUERY or https://www.google.com/search?q=YOUR+QUERY
- write_file: Save results to /workspace/output/

TASK: %s

Instructions:
1. Try web_search first. If it fails, use web_fetch with a search URL.
2. Use web_fetch to read relevant pages in full.
3. Respond with your findings directly in text.
4. If asked for a file, use write_file to save to /workspace/output/.`, prompt)

	if systemPrompt != "" {
		wrappedPrompt += "\n\nADDITIONAL INSTRUCTIONS: " + systemPrompt
	}

	ohArgs := fmt.Sprintf(`-p %s --output-format stream-json --api-format openai --max-turns %d --permission-mode full_auto --append-system-prompt %s`,
		shellQuote(wrappedPrompt), maxTurns, shellQuote(knowledgeAgentSystemPrompt))

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
export OPENHARNESS_CONFIG_DIR="/etc/multica-agent"
oh %s --base-url "$BASE_URL" --api-key "$API_KEY" --model "$MODEL" 2>/dev/null

# Cleanup
kill $MR_PID 2>/dev/null || true
`, shellQuote(model), openRouterBaseURL, openRouterFreeModel, ohArgs)
}

func trySendCloud(ch chan<- agent.Message, msg agent.Message) {
	select {
	case ch <- msg:
	default:
		// Channel full — message dropped. This shouldn't happen with 256 buffer
		// unless the consumer is very slow.
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
