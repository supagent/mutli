package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// ohBackend implements Backend by spawning the OpenHarness CLI
// with --output-format stream-json, pointed at an OpenAI-compatible
// LLM provider (e.g. ModelRelay).
type ohBackend struct {
	cfg Config
}

func (b *ohBackend) Execute(ctx context.Context, prompt string, opts ExecOptions) (*Session, error) {
	if opts.ResumeSessionID != "" {
		return nil, fmt.Errorf("oh backend does not support session resume")
	}

	execPath := b.cfg.ExecutablePath
	if execPath == "" {
		execPath = "oh"
	}
	if _, err := exec.LookPath(execPath); err != nil {
		return nil, fmt.Errorf("oh executable not found at %q: %w", execPath, err)
	}

	timeout := opts.Timeout
	if timeout == 0 {
		timeout = 20 * time.Minute
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)

	args := buildOHArgs(prompt, opts, b.cfg.Env)

	cmd := exec.CommandContext(runCtx, execPath, args...)
	if opts.Cwd != "" {
		cmd.Dir = opts.Cwd
	}
	cmd.Env = buildOHEnv(b.cfg.Env)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("oh stdout pipe: %w", err)
	}
	cmd.Stderr = newLogWriter(b.cfg.Logger, "[oh:stderr] ")

	if err := cmd.Start(); err != nil {
		cancel()
		return nil, fmt.Errorf("start oh: %w", err)
	}

	b.cfg.Logger.Info("oh started", "pid", cmd.Process.Pid, "cwd", opts.Cwd, "model", resolveOHModel(opts, b.cfg.Env))

	msgCh := make(chan Message, 256)
	resCh := make(chan Result, 1)

	go func() {
		defer cancel()
		defer close(resCh)

		startTime := time.Now()
		var output strings.Builder
		finalStatus := "completed"
		var finalError string

		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 0, 1024*1024), 10*1024*1024)

		for scanner.Scan() {
			line := scanner.Text()
			msg, ok := parseOHLine(line)
			if !ok {
				continue
			}

			if msg.Type == MessageText {
				output.WriteString(msg.Content)
			}
			if msg.Type == MessageError {
				finalError = msg.Content
			}

			trySend(msgCh, msg)
		}

		scanErr := scanner.Err()
		if scanErr != nil {
			_ = cmd.Process.Kill()
		}

		exitErr := cmd.Wait()
		duration := time.Since(startTime)

		if scanErr != nil {
			finalStatus = "failed"
			if finalError == "" {
				finalError = fmt.Sprintf("oh stdout read failed: %v", scanErr)
			}
		} else if runCtx.Err() == context.DeadlineExceeded {
			finalStatus = "timeout"
			finalError = fmt.Sprintf("oh timed out after %s", timeout)
		} else if runCtx.Err() == context.Canceled {
			finalStatus = "aborted"
			finalError = "execution cancelled"
		} else if exitErr != nil && finalStatus == "completed" {
			finalStatus = "failed"
			if finalError == "" {
				finalError = fmt.Sprintf("oh exited with error: %v", exitErr)
			}
		}

		b.cfg.Logger.Info("oh finished", "pid", cmd.Process.Pid, "status", finalStatus, "duration", duration.Round(time.Millisecond).String())

		close(msgCh)
		resCh <- Result{
			Status:     finalStatus,
			Output:     output.String(),
			Error:      finalError,
			DurationMs: duration.Milliseconds(),
		}
	}()

	return &Session{Messages: msgCh, Result: resCh}, nil
}

// buildOHArgs constructs the argument list for the oh CLI.
func buildOHArgs(prompt string, opts ExecOptions, env map[string]string) []string {
	baseURL := envOr(env, "MULTICA_OH_BASE_URL", "http://localhost:7352/v1")
	apiKey := envOr(env, "MULTICA_OH_API_KEY", "dummy")
	model := resolveOHModel(opts, env)

	maxTurns := opts.MaxTurns
	if maxTurns == 0 {
		maxTurns = 25
	}

	args := []string{
		"-p", prompt,
		"--output-format", "stream-json",
		"--api-format", "openai",
		"--base-url", baseURL,
		"--api-key", apiKey,
		"--model", model,
		"--max-turns", fmt.Sprintf("%d", maxTurns),
		"--permission-mode", "full_auto",
		"--bare",
	}

	if opts.SystemPrompt != "" {
		args = append(args, "--append-system-prompt", opts.SystemPrompt)
	}

	return args
}

// resolveOHModel returns the model to use, checking opts then env then default.
func resolveOHModel(opts ExecOptions, env map[string]string) string {
	if opts.Model != "" {
		return opts.Model
	}
	return envOr(env, "MULTICA_OH_MODEL", "auto-fastest")
}

// buildOHEnv constructs the environment for the oh subprocess.
func buildOHEnv(extra map[string]string) []string {
	env := buildEnv(extra)

	// Ensure OPENHARNESS_CONFIG_DIR is set for denied_tools enforcement.
	// If not already set, check for a config dir with our settings.
	hasConfigDir := false
	for _, e := range env {
		if strings.HasPrefix(e, "OPENHARNESS_CONFIG_DIR=") {
			hasConfigDir = true
			break
		}
	}
	if !hasConfigDir {
		if configDir, ok := extra["OPENHARNESS_CONFIG_DIR"]; ok && configDir != "" {
			env = append(env, "OPENHARNESS_CONFIG_DIR="+configDir)
		}
	}

	return env
}

// envOr returns the value from the map, or the os env, or the default.
func envOr(env map[string]string, key, fallback string) string {
	if v, ok := env[key]; ok && v != "" {
		return v
	}
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// --- OH stream-json parser ---
// OH emits one JSON object per line to stdout with --output-format stream-json.

// ansiPattern matches ANSI CSI and OSC escape sequences.
var ansiPattern = regexp.MustCompile(`\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07]*\x07)`)

// ohStreamEvent represents a single OH stream-json event.
type ohStreamEvent struct {
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`
	ToolName  string          `json:"tool_name,omitempty"`
	ToolInput json.RawMessage `json:"tool_input,omitempty"`
	Output    string          `json:"output,omitempty"`
	IsError   bool            `json:"is_error,omitempty"`
	Message   string          `json:"message,omitempty"`
	Phase     string          `json:"phase,omitempty"`
}

// parseOHLine parses a raw stdout line from OH into an agent.Message.
// Returns false if the line is not valid OH stream-json.
func parseOHLine(raw string) (Message, bool) {
	line := ansiPattern.ReplaceAllString(raw, "")
	line = strings.ReplaceAll(line, "\r\n", "\n")
	line = strings.TrimRight(line, "\r")
	line = strings.TrimSpace(line)
	if line == "" || line[0] != '{' {
		return Message{}, false
	}

	var ev ohStreamEvent
	if err := json.Unmarshal([]byte(line), &ev); err != nil {
		return Message{}, false
	}

	switch ev.Type {
	case "assistant_delta":
		return Message{Type: MessageText, Content: ev.Text}, true
	case "assistant_complete":
		return Message{Type: MessageText, Content: ev.Text}, true
	case "tool_started":
		var input map[string]any
		if len(ev.ToolInput) > 0 {
			_ = json.Unmarshal(ev.ToolInput, &input)
		}
		return Message{Type: MessageToolUse, Tool: ev.ToolName, Input: input}, true
	case "tool_completed":
		return Message{Type: MessageToolResult, Tool: ev.ToolName, Output: ev.Output}, true
	case "error":
		return Message{Type: MessageError, Content: ev.Message}, true
	case "status":
		return Message{Type: MessageStatus, Status: ev.Message}, true
	case "system":
		return Message{Type: MessageLog, Content: ev.Message, Level: "info"}, true
	case "compact_progress":
		msg := ev.Message
		if msg == "" {
			msg = ev.Phase
		}
		return Message{Type: MessageStatus, Status: msg}, true
	default:
		return Message{}, false
	}
}
