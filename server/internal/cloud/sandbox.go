package cloud

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/daytonaio/daytona/libs/sdk-go/pkg/daytona"
	"github.com/daytonaio/daytona/libs/sdk-go/pkg/options"
	"github.com/daytonaio/daytona/libs/sdk-go/pkg/types"
	agentpy "github.com/multica-ai/multica/server/agent"
	"github.com/multica-ai/multica/server/pkg/agent"
)

const (
	defaultModel        = "gemini-2.5-flash"
	defaultMaxTurns     = 20
	defaultTimeout      = 20 * time.Minute
	defaultImageTimeout = 3 * time.Minute // Python + pip install google-adk (cached after first build)
)

// Embedded ADK agent files (compiled into the binary via go:embed in server/agent/embed.go).
var (
	agentMainPy        = agentpy.MainPy
	agentBridgePy      = agentpy.BridgePy
	agentToolsPy       = agentpy.ToolsPy
	agentRequirements  = agentpy.RequirementsTxt
)

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

// SetAgentToken updates the auth token used by embedded agents for API calls.
// Called after daemon authentication resolves.
func (sm *SandboxManager) SetAgentToken(token string) {
	sm.cfg.AgentToken = token
}

// Close shuts down the Daytona client.
func (sm *SandboxManager) Close(ctx context.Context) {
	sm.client.Close(ctx)
}

// Execute runs an ADK agent inside a Daytona sandbox, returning
// a Session with streaming messages and a final result.
// Implements agent.SandboxExecutor.
func (sm *SandboxManager) Execute(ctx context.Context, cfg agent.SandboxTaskConfig) (*agent.Session, error) {
	taskCfg := TaskExecConfig{
		TaskID:       cfg.TaskID,
		IssueID:      cfg.IssueID,
		WorkspaceID:  cfg.WorkspaceID,
		Prompt:       cfg.Prompt,
		Model:        cfg.Model,
		MaxTurns:     cfg.MaxTurns,
		SystemPrompt: cfg.SystemPrompt,
		Timeout:      cfg.Timeout,
		SubAgents:    cfg.SubAgents,
		Role:         cfg.Role,
		ToolsMode:    cfg.ToolsMode,
	}
	return sm.execute(ctx, taskCfg)
}

func (sm *SandboxManager) execute(ctx context.Context, taskCfg TaskExecConfig) (*agent.Session, error) {
	// Fail fast: Gemini API key is required for embedded agent execution.
	if sm.cfg.GeminiAPIKey == "" {
		return nil, fmt.Errorf("GOOGLE_AI_API_KEY is required for embedded agent execution")
	}

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

	trySendCloud(msgCh, agent.Message{Type: agent.MessageSetup, Content: "Creating sandbox"})

	// Build sandbox image: Python + ADK deps from pinned requirements.txt.
	// Image is cached by Daytona after first build — sub-second subsequent creates.
	// Dependencies change only when requirements.txt is updated (rebuild on deploy).
	image := daytona.DebianSlim(nil).
		PipInstall(pipDepsFromRequirements())

	imageTimeout := sm.cfg.ImageTimeout
	if imageTimeout == 0 {
		imageTimeout = defaultImageTimeout
	}

	// Create sandbox with env vars for ADK agent
	sm.logger.Info("creating sandbox", "task", taskCfg.TaskID, "model", model)
	envVars := map[string]string{
		"GOOGLE_API_KEY": sm.cfg.GeminiAPIKey,
	}
	if sm.cfg.MulicaAPIURL != "" {
		envVars["MULTICA_API_URL"] = sm.cfg.MulicaAPIURL
	}
	if sm.cfg.AgentToken != "" {
		envVars["MULTICA_AGENT_TOKEN"] = sm.cfg.AgentToken
	}
	if taskCfg.WorkspaceID != "" {
		envVars["MULTICA_WORKSPACE_ID"] = taskCfg.WorkspaceID
	}
	if taskCfg.TaskID != "" {
		envVars["MULTICA_TASK_ID"] = taskCfg.TaskID
	}
	if taskCfg.ToolsMode != "" {
		envVars["MULTICA_TOOLS_MODE"] = taskCfg.ToolsMode
	}

	sandbox, err := sm.client.Create(runCtx, types.ImageParams{
		SandboxBaseParams: types.SandboxBaseParams{
			EnvVars:         envVars,
			NetworkBlockAll: false,
		},
		Image: image,
	}, options.WithTimeout(imageTimeout))
	if err != nil {
		cancel()
		return nil, fmt.Errorf("create sandbox: %w", err)
	}
	sm.logger.Info("sandbox created", "task", taskCfg.TaskID, "sandbox", sandbox.ID)
	trySendCloud(msgCh, agent.Message{Type: agent.MessageSetup, Content: "Uploading agent"})

	// Upload ADK agent Python files (embedded at compile time).
	sandbox.Process.ExecuteCommand(runCtx, "mkdir -p /workspace/agent /workspace/output")

	agentFiles := []struct {
		data []byte
		path string
	}{
		{agentMainPy, "/workspace/agent/multica_agent.py"},
		{agentBridgePy, "/workspace/agent/bridge.py"},
		{agentToolsPy, "/workspace/agent/tools.py"},
	}
	for _, f := range agentFiles {
		if err := sandbox.FileSystem.UploadFile(runCtx, f.data, f.path); err != nil {
			cleanupSandbox(sandbox, sm.logger)
			cancel()
			return nil, fmt.Errorf("upload %s: %w", f.path, err)
		}
	}

	// Upload sub-agent definitions for multi-agent orchestration.
	if len(taskCfg.SubAgents) > 0 {
		subAgentJSON, err := json.Marshal(taskCfg.SubAgents)
		if err != nil {
			cleanupSandbox(sandbox, sm.logger)
			cancel()
			return nil, fmt.Errorf("marshal sub-agents: %w", err)
		}
		if err := sandbox.FileSystem.UploadFile(runCtx, subAgentJSON, "/workspace/agent/sub_agents.json"); err != nil {
			cleanupSandbox(sandbox, sm.logger)
			cancel()
			return nil, fmt.Errorf("upload sub_agents.json: %w", err)
		}
		sm.logger.Info("uploaded sub-agent definitions", "task", taskCfg.TaskID, "count", len(taskCfg.SubAgents))
	}

	// Create PTY session for streaming output
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

	// Scale maxTurns for orchestrators: the total sandbox turn budget must
	// accommodate the orchestrator + all sub-agents. Each sub-agent has its
	// own independent turn limiter (before_model_callback) so the per-agent
	// cap stays at baseTurns — this only affects the global sandbox ceiling.
	if len(taskCfg.SubAgents) > 0 {
		maxTurns = maxTurns * (1 + len(taskCfg.SubAgents))
	}

	// Build the agent command
	subAgentsArg := ""
	if len(taskCfg.SubAgents) > 0 {
		subAgentsArg = " --sub-agents /workspace/agent/sub_agents.json"
	}
	systemPromptArg := ""
	if taskCfg.SystemPrompt != "" {
		systemPromptArg = " --system-prompt " + shellQuote(taskCfg.SystemPrompt)
	}
	roleArg := ""
	if taskCfg.Role != "" {
		roleArg = " --role " + shellQuote(taskCfg.Role)
	}
	cmd := fmt.Sprintf("cd /workspace/agent && python3 multica_agent.py --task-id %s --issue-id %s --prompt %s --model %s --max-turns %d%s%s%s\nexit\n",
		shellQuote(taskCfg.TaskID),
		shellQuote(taskCfg.IssueID),
		shellQuote(taskCfg.Prompt),
		shellQuote(model),
		maxTurns,
		subAgentsArg,
		systemPromptArg,
		roleArg,
	)

	trySendCloud(msgCh, agent.Message{Type: agent.MessageSetup, Content: "Starting agent"})
	sm.logger.Info("running ADK agent in sandbox", "task", taskCfg.TaskID, "model", model)

	// Execute via PTY for streaming output
	if _, err := handle.Write([]byte(cmd)); err != nil {
		handle.Disconnect()
		cleanupSandbox(sandbox, sm.logger)
		cancel()
		close(msgCh)
		return nil, fmt.Errorf("write to pty: %w", err)
	}

	// Stop sandbox on external cancellation (user cancel or timeout), but NOT on
	// normal completion.
	var normalExit atomic.Bool
	go func() {
		<-runCtx.Done()
		if normalExit.Load() {
			return
		}
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer stopCancel()
		if err := sandbox.Stop(stopCtx); err != nil {
			sm.logger.Warn("sandbox stop on cancel failed", "task", taskCfg.TaskID, "error", err)
		} else {
			sm.logger.Info("sandbox stopped on cancellation", "task", taskCfg.TaskID)
		}
	}()

	// Result channel
	resCh := make(chan agent.Result, 1)

	// Drain PTY output in background, parsing NDJSON events
	go func() {
		defer cancel()
		defer close(resCh)

		startTime := time.Now()

		// Drain PTY data, parsing NDJSON lines via ParseNDJSONLine.
		agentResult := drainNDJSON(runCtx, handle.DataChan(), msgCh)
		close(msgCh)

		handle.Disconnect()
		duration := time.Since(startTime)

		// Build final result — prefer the agent's own result event if available.
		finalStatus := "completed"
		var finalOutput, finalError string
		var usage map[string]agent.TokenUsage

		if agentResult != nil {
			finalStatus = agentResult.Status
			finalOutput = agentResult.Output
			finalError = agentResult.Error
			usage = agentResult.Usage
		}

		// Override status on context errors (timeout/cancel takes precedence).
		if runCtx.Err() == context.DeadlineExceeded {
			finalStatus = "timeout"
			finalError = fmt.Sprintf("sandbox timed out after %s", timeout)
		} else if runCtx.Err() == context.Canceled && finalStatus != "completed" {
			finalStatus = "aborted"
			finalError = "execution cancelled"
		}

		sm.logger.Info("sandbox task finished", "task", taskCfg.TaskID, "status", finalStatus,
			"duration", duration.Round(time.Millisecond))

		// Signal normal completion so the Stop goroutine doesn't fire on cleanup.
		normalExit.Store(true)

		// Extract artifacts from /workspace/output/ before destroying the sandbox.
		var artifacts []agent.Artifact
		if finalStatus == "completed" {
			artifacts = extractArtifacts(runCtx, sandbox, sm.logger)
		}

		// Fallback: synthesize report.md from text output if no artifacts.
		if len(artifacts) == 0 && finalOutput != "" && finalStatus == "completed" {
			sm.logger.Info("no artifacts found, synthesizing report from text output", "textLen", len(finalOutput))
			artifacts = append(artifacts, agent.Artifact{
				Filename:    "report.md",
				Data:        []byte(finalOutput),
				ContentType: "text/markdown",
			})
		}

		// Use clean report content when available.
		if finalStatus == "completed" && len(artifacts) > 0 {
			for _, a := range artifacts {
				if a.Filename == "report.md" && len(a.Data) > 0 {
					finalOutput = string(a.Data)
					break
				}
			}
		}

		// Cleanup sandbox
		cleanupSandbox(sandbox, sm.logger)

		resCh <- agent.Result{
			Status:     finalStatus,
			Output:     finalOutput,
			Error:      finalError,
			DurationMs: duration.Milliseconds(),
			Usage:      usage,
			Artifacts:  artifacts,
		}
	}()

	return &agent.Session{Messages: msgCh, Result: resCh}, nil
}

// drainNDJSON reads from a PTY data channel, buffers partial lines,
// parses complete lines via ParseNDJSONLine, and sends messages to msgCh.
// Returns the agent's result event if one was received, or nil.
func drainNDJSON(ctx context.Context, dataCh <-chan []byte, msgCh chan<- agent.Message) *agent.Result {
	var agentResult *agent.Result

	processLine := func(line string) {
		msg, result, ok := ParseNDJSONLine(line)
		if !ok {
			if trimmed := strings.TrimSpace(line); trimmed != "" && !strings.HasPrefix(trimmed, "$") && !strings.HasPrefix(trimmed, "daytona@") {
				slog.Warn("sandbox non-json output", "line", trimmed)
			}
			return
		}
		if result != nil {
			agentResult = result
			return
		}
		trySendCloud(msgCh, msg)
	}

	processChunk := func(data []byte, lineBuf *strings.Builder) {
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
			processLine(line)
		}
	}

	flushLineBuf := func(lineBuf *strings.Builder) {
		if remaining := strings.TrimSpace(lineBuf.String()); remaining != "" {
			processLine(remaining)
		}
	}

	var lineBuf strings.Builder
	for {
		select {
		case <-ctx.Done():
			drainTimeout := time.After(2 * time.Second)
			for {
				select {
				case data, ok := <-dataCh:
					if !ok {
						flushLineBuf(&lineBuf)
						return agentResult
					}
					processChunk(data, &lineBuf)
				case <-drainTimeout:
					flushLineBuf(&lineBuf)
					return agentResult
				}
			}
		case data, ok := <-dataCh:
			if !ok {
				flushLineBuf(&lineBuf)
				return agentResult
			}
			processChunk(data, &lineBuf)
		}
	}
}

// shellQuote wraps a string in single quotes for safe shell interpolation.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

// pipDepsFromRequirements parses the embedded requirements.txt into a slice
// of pip dependency strings for Daytona's PipInstall builder.
func pipDepsFromRequirements() []string {
	var deps []string
	for _, line := range strings.Split(string(agentRequirements), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		deps = append(deps, line)
	}
	return deps
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
