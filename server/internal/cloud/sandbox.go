package cloud

import (
	"context"
	"fmt"
	"log/slog"
	"mime"
	"net/http"
	"path/filepath"
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

	// Fallback LLM provider when ModelRelay fails to start.
	// Uses Gemini via Google AI Studio's OpenAI-compatible endpoint.
	fallbackModel   = "gemini-2.5-flash"
	fallbackBaseURL = "https://generativelanguage.googleapis.com/v1beta/openai/"
)

// Denied tools config for knowledge worker mode.
var deniedToolsJSON = `{
	"permission": {
		"mode": "full_auto",
		"denied_tools": ["agent", "ask_user_question", "bash", "brief", "config", "cron_create", "cron_delete", "cron_list", "cron_toggle", "enter_plan_mode", "enter_worktree", "exit_plan_mode", "exit_worktree", "file_edit", "file_read", "glob", "grep", "list_mcp_resources", "lsp", "mcp_auth", "mcp", "notebook_edit", "read_mcp_resource", "remote_trigger", "send_message", "skill", "sleep", "task_create", "task_get", "task_list", "task_output", "task_stop", "task_update", "team_create", "team_delete", "todo_write", "tool_search"]
	}
}`

// searchProxyScript is a Python HTTP server that proxies web searches through
// Gemini's native API with search grounding. This bypasses Daytona's network
// restrictions (which block general HTTPS) since googleapis.com is allowed.
// OH's web_search tool is configured to use http://localhost:8888/ as the
// search endpoint. The proxy returns DuckDuckGo-formatted HTML that OH's
// parser can extract results from.
var searchProxyScript = `#!/usr/bin/env python3
"""Search proxy: uses Gemini search grounding to bypass sandbox network restrictions.

Fixes applied:
1. Real URLs extracted from grounding metadata (not redirect URLs)
2. Retry with backoff on Gemini API errors (2 attempts)
3. ThreadingHTTPServer for concurrent requests
4. 12s timeout on Gemini calls (within OH's 20s web_search timeout)
5. Full Gemini response text included as rich snippets
6. Query result caching (avoids duplicate API calls within a task)
7. Structured error messages for better agent behavior
"""
import json, os, re, sys, time, threading, urllib.request, urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

GEMINI_KEY = os.environ.get("OPENAI_API_KEY", "")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
MAX_RETRIES = 2
RETRY_DELAY = 1.5
API_TIMEOUT = 12

# Simple thread-safe cache: query -> (timestamp, html)
_cache = {}
_cache_lock = threading.Lock()
CACHE_TTL = 300  # 5 minutes

class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

class SearchHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
            return
        params = urllib.parse.parse_qs(parsed.query)
        query = params.get("q", [""])[0]
        if not query:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"Missing q parameter")
            return

        # Check cache first
        cached = self._get_cached(query)
        if cached:
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(cached.encode())
            return

        # Search with retry
        last_err = None
        for attempt in range(MAX_RETRIES):
            try:
                results, full_text = self._search(query)
                html = self._to_ddg_html(query, results, full_text)
                self._set_cached(query, html)
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(html.encode())
                return
            except Exception as e:
                last_err = e
                if attempt < MAX_RETRIES - 1:
                    time.sleep(RETRY_DELAY * (attempt + 1))
        self.send_response(502)
        self.end_headers()
        self.wfile.write(f"Search failed after {MAX_RETRIES} attempts: {last_err}".encode())

    def _get_cached(self, query):
        key = query.lower().strip()
        with _cache_lock:
            if key in _cache:
                ts, html = _cache[key]
                if time.time() - ts < CACHE_TTL:
                    return html
                del _cache[key]
        return None

    def _set_cached(self, query, html):
        key = query.lower().strip()
        with _cache_lock:
            _cache[key] = (time.time(), html)

    def _search(self, query):
        body = json.dumps({
            "contents": [{"parts": [{"text": query}]}],
            "tools": [{"google_search": {}}],
        }).encode()
        req = urllib.request.Request(
            f"{GEMINI_URL}?key={GEMINI_KEY}",
            data=body,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=API_TIMEOUT) as resp:
            data = json.loads(resp.read())
        results = []
        candidates = data.get("candidates", [])
        if not candidates:
            return results, ""
        meta = candidates[0].get("groundingMetadata", {})
        for chunk in meta.get("groundingChunks", []):
            web = chunk.get("web", {})
            title = web.get("title", "")
            uri = web.get("uri", "")
            # Extract real URL: grounding redirects contain the domain in the title.
            # Use title as the domain and construct a clean URL.
            # The redirect URIs are not fetchable from the sandbox, so we use
            # the title (which is the actual domain name like "example.com").
            if title and uri:
                real_url = f"https://{title}" if not title.startswith("http") else title
                results.append({"title": title, "url": real_url})
        # Extract full response text for rich context
        text_parts = candidates[0].get("content", {}).get("parts", [])
        full_text = " ".join(p.get("text", "") for p in text_parts)
        return results, full_text

    def _to_ddg_html(self, query, results, full_text):
        # Include the full Gemini response as a rich context block that OH can
        # see in the search results. This means the agent gets the grounded
        # answer directly without needing to web_fetch individual pages.
        items = []
        if full_text:
            # Add the full grounded response as the first "result"
            snippet = full_text.replace("<", "&lt;")[:3000]
            items.append(
                f'<div class="result">'
                f'<a class="result__a" href="https://google.com/search?q={urllib.parse.quote(query)}">Research Summary</a>'
                f'<span class="result__snippet">{snippet}</span>'
                f'</div>'
            )
        for r in results:
            title = r["title"].replace("<", "&lt;")
            url = r["url"].replace('"', "&quot;")
            items.append(
                f'<div class="result">'
                f'<a class="result__a" href="{url}">{title}</a>'
                f'<span class="result__snippet">Source: {title}</span>'
                f'</div>'
            )
        return f"<html><body>{''.join(items)}</body></html>"

    def log_message(self, format, *args):
        pass  # Suppress request logging

if __name__ == "__main__":
    if not GEMINI_KEY:
        print("FATAL: OPENAI_API_KEY not set", file=sys.stderr)
        sys.exit(1)
    server = ThreadingHTTPServer(("127.0.0.1", 8888), SearchHandler)
    print("Search proxy ready on http://localhost:8888", file=sys.stderr)
    server.serve_forever()
`

// researchInstructions is the CLAUDE.md uploaded to the sandbox working directory.
// It overrides the default OH coding-assistant identity.
var researchInstructions = `# Agent Identity

You are a **research and knowledge agent**, NOT a coding assistant. You do NOT write code, run shell commands, or edit files. You research topics using the web and deliver findings as structured files.

## Your Tools

You have exactly THREE tools. Do not attempt to use any others:

1. **web_search** — Search the internet. IMPORTANT: Always pass search_url="http://localhost:8888/". Search results include a grounded summary — use it directly.
2. **web_fetch** — Read a specific known webpage. Do NOT use with URLs from search results (they may be blocked). Only use if you have a specific URL you know works.
3. **write_file** — Write your findings to a file. ALWAYS write to /workspace/output/.

All other tools (bash, glob, grep, read_file, file_edit, etc.) are DISABLED and will be denied if you try them.

## How to Work

1. Read the task description in your prompt carefully.
2. Use web_search to find relevant information (at least 3 searches).
3. Use web_fetch to read important pages in full.
4. ALWAYS use write_file to save your findings to /workspace/output/report.md (or .csv if tabular data is appropriate).
5. After writing the file(s), provide a brief text summary of what you found and what files you created.

## CRITICAL RULE: You MUST use write_file

Every task MUST end with at least one write_file call to /workspace/output/. NEVER deliver your findings only as text in your response. The user expects downloadable file attachments. If you do not call write_file, the task has FAILED.

## Other Rules

- NEVER try to run bash commands, read local files, or use coding tools.
- NEVER generate data from memory — every fact must come from a web search in this session.
- ALWAYS cite sources with URLs.
- If you cannot find information, say "data not publicly available" rather than guessing.
`

// knowledgeAgentSystemPrompt is appended to OH's system prompt via --append-system-prompt.
// It reinforces the agent identity since OH's default prompt says "coding assistant."
var knowledgeAgentSystemPrompt = `IMPORTANT OVERRIDE: Ignore any prior instructions about being a "coding assistant" or helping with "software engineering tasks." You are a RESEARCH AGENT. Your only job is to search the web, read pages, and write findings to files. You have three tools: web_search, web_fetch, and write_file. All other tools are disabled. You MUST call write_file at least once per task to save your findings to /workspace/output/. NEVER deliver findings only as text — the user expects downloadable file attachments. Start every task by searching the web, then ALWAYS finish by writing files.`

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

	// Resolve fallback LLM API key (Google AI Studio)
	fallbackKey := sm.cfg.FallbackAPIKey

	// Create sandbox with env vars for ModelRelay + Google AI Studio fallback
	sm.logger.Info("creating sandbox", "task", taskCfg.TaskID, "model", model)
	envVars := map[string]string{
		"TERM":                   "dumb",
		"OPENHARNESS_CONFIG_DIR": "/etc/multica-agent",
	}
	if fallbackKey != "" {
		envVars["FALLBACK_API_KEY"] = fallbackKey
	}

	sandbox, err := sm.client.Create(runCtx, types.ImageParams{
		SandboxBaseParams: types.SandboxBaseParams{
			EnvVars:         envVars,
			NetworkBlockAll: false, // Allow outbound network access for web_search/web_fetch
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

	// Upload search proxy (bypasses Daytona network restrictions via Gemini search grounding)
	if err := sandbox.FileSystem.UploadFile(runCtx, []byte(searchProxyScript), "/tmp/search-proxy.py"); err != nil {
		sm.logger.Warn("failed to upload search proxy (non-fatal)", "error", err)
	}

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
	entrypoint := buildEntrypointScript(taskCfg.Prompt, model, maxTurns, taskCfg.SystemPrompt, fallbackKey)
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

		// Extract artifacts from /workspace/output/ before destroying the sandbox.
		var artifacts []agent.Artifact
		if finalStatus == "completed" {
			artifacts = extractArtifacts(runCtx, sandbox, sm.logger)
		}

		// Cleanup sandbox
		cleanupSandbox(sandbox, sm.logger)

		resCh <- agent.Result{
			Status:     finalStatus,
			Output:     finalOutput,
			Error:      finalError,
			DurationMs: duration.Milliseconds(),
			Artifacts:  artifacts,
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
				} else if trimmed := strings.TrimSpace(line); trimmed != "" && !strings.HasPrefix(trimmed, "$") && !strings.HasPrefix(trimmed, "daytona@") {
					// Log non-JSON lines (Python tracebacks, errors, etc.)
					slog.Warn("sandbox non-json output", "line", trimmed)
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
// 1. If fallbackAPIKey is set, uses Google AI Studio (Gemini) directly
// 2. Otherwise starts ModelRelay, health-checks, uses if available
// 3. Runs OH with the resolved provider
func buildEntrypointScript(prompt, model string, maxTurns int, systemPrompt, fallbackAPIKey string) string {
	// Wrap the user's task in explicit identity + instructions.
	// This goes in the -p prompt itself (not --append-system-prompt) because
	// the default OH system prompt says "coding assistant" and the model
	// follows that over appended overrides.
	wrappedPrompt := fmt.Sprintf(`You are a RESEARCH AGENT. You are NOT a coding assistant. Do NOT use bash, glob, grep, read_file, or any coding tools — they are all disabled and will be denied.

You have ONLY these 3 tools:
- web_search: Search the internet. IMPORTANT: You MUST pass search_url="http://localhost:8888/" every time you call web_search. The default search engine is blocked. The search results include a detailed "Research Summary" with grounded facts — use this directly instead of fetching individual pages.
- web_fetch: Read a specific webpage. ONLY use this if web_search results are insufficient and you need to read a specific known URL. Do NOT use web_fetch with URLs from search results (they may be blocked).
- write_file: Save results to /workspace/output/. You MUST use this for EVERY task.

TASK: %s

Instructions:
1. Use web_search with search_url="http://localhost:8888/" to find information. The search results include a grounded summary with facts — use it directly.
2. Do additional web_search calls with different queries to find more details.
3. ALWAYS use write_file to save your complete findings to /workspace/output/report.md (use .csv instead if the task requires tabular data).
4. After writing file(s), give a brief text summary of what you found and what files you created.

IMPORTANT: You MUST call write_file at least once. NEVER deliver findings only as text. The task FAILS if you do not write files.
IMPORTANT: Always pass search_url="http://localhost:8888/" when calling web_search.
IMPORTANT: Do NOT use web_fetch with URLs from search results — they are not directly accessible. Use the search summary instead.`, prompt)

	if systemPrompt != "" {
		wrappedPrompt += "\n\nADDITIONAL INSTRUCTIONS: " + systemPrompt
	}

	ohArgs := fmt.Sprintf(`-p %s --output-format stream-json --api-format openai --max-turns %d --permission-mode full_auto --append-system-prompt %s`,
		shellQuote(wrappedPrompt), maxTurns, shellQuote(knowledgeAgentSystemPrompt))

	// Inject the fallback API key directly into the script (env vars may not
	// propagate through Daytona PTY sessions).
	fallbackKeyLiteral := ""
	if fallbackAPIKey != "" {
		fallbackKeyLiteral = fallbackAPIKey
	}

	return fmt.Sprintf(`#!/bin/bash

# Start search proxy (Gemini search grounding, bypasses sandbox network restrictions)
export OPENAI_API_KEY="%s"
python3 /tmp/search-proxy.py &
PROXY_PID=$!

# Wait for proxy to be ready (up to 5s)
for i in $(seq 1 10); do
  if curl -sf --max-time 1 "http://localhost:8888/health" > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo '{"type":"system","message":"Using Google AI Studio (Gemini) with search proxy"}'
export OPENAI_BASE_URL="%s"
export OPENHARNESS_CONFIG_DIR="/etc/multica-agent"
oh %s --base-url "%s" --api-key "%s" --model "%s" || echo "{\"type\":\"error\",\"message\":\"oh exited with code $?\"}"

kill $PROXY_PID 2>/dev/null
`, fallbackKeyLiteral, fallbackBaseURL, ohArgs, fallbackBaseURL, fallbackKeyLiteral, fallbackModel)
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

const (
	artifactOutputDir = "/workspace/output/"
	maxArtifactSize   = 5 << 20  // 5 MB per file
	maxTotalArtifacts = 20 << 20 // 20 MB total
)

// extractArtifacts lists and downloads top-level files from /workspace/output/.
// Subdirectories are ignored. Returns nil (no error) if the directory is empty
// or doesn't exist — artifact extraction is best-effort.
func extractArtifacts(ctx context.Context, sandbox *daytona.Sandbox, logger *slog.Logger) []agent.Artifact {
	files, err := sandbox.FileSystem.ListFiles(ctx, artifactOutputDir)
	if err != nil {
		logger.Warn("artifact extraction: failed to list output dir", "error", err)
		return nil
	}

	var artifacts []agent.Artifact
	var totalSize int64

	for _, f := range files {
		if f.IsDirectory {
			logger.Info("artifact extraction: skipping subdirectory", "name", f.Name)
			continue
		}

		// Sanitize filename — reject path traversal, control chars, etc.
		safeName, ok := sanitizeFilename(f.Name)
		if !ok {
			logger.Warn("artifact extraction: rejected unsafe filename", "name", f.Name)
			continue
		}

		// Check file type allowlist.
		if !isAllowedFileType(safeName) {
			logger.Warn("artifact extraction: file type not allowed, skipping",
				"name", safeName, "ext", filepath.Ext(safeName))
			continue
		}

		if f.Size > maxArtifactSize {
			logger.Warn("artifact extraction: file exceeds size limit, skipping",
				"name", safeName, "size", f.Size, "limit", maxArtifactSize)
			continue
		}
		if totalSize+f.Size > maxTotalArtifacts {
			logger.Warn("artifact extraction: total size limit reached, skipping remaining files",
				"name", safeName, "totalSoFar", totalSize, "limit", maxTotalArtifacts)
			break
		}

		remotePath := artifactOutputDir + f.Name
		data, err := sandbox.FileSystem.DownloadFile(ctx, remotePath, nil)
		if err != nil {
			logger.Warn("artifact extraction: failed to download file", "name", safeName, "error", err)
			continue
		}

		totalSize += int64(len(data))
		artifacts = append(artifacts, agent.Artifact{
			Filename:    safeName,
			Data:        data,
			ContentType: detectContentType(safeName, data),
		})
		logger.Info("artifact extracted", "name", safeName, "size", len(data))
	}

	if len(artifacts) > 0 {
		logger.Info("artifact extraction complete", "count", len(artifacts), "totalBytes", totalSize)
	}
	return artifacts
}

// detectContentType returns a MIME type for the given filename, falling back
// to http.DetectContentType for unknown extensions.
func detectContentType(filename string, data []byte) string {
	ext := strings.ToLower(filepath.Ext(filename))
	// Check the extension-override map from file.go conventions.
	if ct, ok := extContentTypes[ext]; ok {
		return ct
	}
	// Standard mime package lookup.
	if ct := mime.TypeByExtension(ext); ct != "" {
		return ct
	}
	// Fallback to content sniffing.
	return http.DetectContentType(data)
}

// extContentTypes mirrors the overrides in handler/file.go for consistency.
var extContentTypes = map[string]string{
	".md":   "text/markdown",
	".csv":  "text/csv",
	".json": "application/json",
	".svg":  "image/svg+xml",
}

// allowedFileTypes are the only extensions extracted from the sandbox.
var allowedFileTypes = map[string]bool{
	".md":   true,
	".csv":  true,
	".json": true,
	".txt":  true,
	".pdf":  true,
	".xlsx": true,
}

// isAllowedFileType returns true if the filename has an allowed extension.
func isAllowedFileType(filename string) bool {
	ext := strings.ToLower(filepath.Ext(filename))
	return allowedFileTypes[ext]
}

// sanitizeFilename validates and cleans a filename from the sandbox.
// Returns the sanitized name and true if valid, or empty string and false if rejected.
func sanitizeFilename(name string) (string, bool) {
	if name == "" || name == "." || name == ".." {
		return "", false
	}
	// Reject control characters and null bytes.
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return "", false
		}
	}
	// Reject path separators (no subdirectory traversal).
	if strings.ContainsAny(name, "/\\") {
		return "", false
	}
	// Reject path traversal patterns.
	if strings.Contains(name, "..") {
		return "", false
	}
	return name, true
}
