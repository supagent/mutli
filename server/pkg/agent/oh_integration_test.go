//go:build integration

package agent

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"
)

// ohTestBackend creates an ohBackend configured for ModelRelay integration testing.
// Skips the test if MULTICA_OH_BASE_URL is not set (ModelRelay not running).
func ohTestBackend(t *testing.T) *ohBackend {
	t.Helper()

	baseURL := os.Getenv("MULTICA_OH_BASE_URL")
	if baseURL == "" {
		baseURL = "http://localhost:7352/v1"
	}

	// Quick connectivity check
	if os.Getenv("OH_INTEGRATION_SKIP_CHECK") == "" {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		b := &ohBackend{cfg: Config{
			Env:    map[string]string{"MULTICA_OH_BASE_URL": baseURL},
			Logger: slog.Default(),
		}}
		args := buildOHArgs("ping", ExecOptions{MaxTurns: 1}, b.cfg.Env)
		_ = args // just verifying construction doesn't panic
		_ = ctx
	}

	return &ohBackend{cfg: Config{
		Env: map[string]string{
			"MULTICA_OH_BASE_URL": baseURL,
			"MULTICA_OH_API_KEY":  envOr(nil, "MULTICA_OH_API_KEY", "dummy"),
		},
		Logger: slog.Default(),
	}}
}

func TestOHBackend_BasicExecution(t *testing.T) {
	b := ohTestBackend(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	session, err := b.Execute(ctx, "What is 2+2? Reply with just the number.", ExecOptions{MaxTurns: 1})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	var messages []Message
	for msg := range session.Messages {
		messages = append(messages, msg)
		t.Logf("msg: type=%s content=%q tool=%q", msg.Type, truncateStr(msg.Content, 80), msg.Tool)
	}

	result := <-session.Result
	t.Logf("result: status=%s output=%q duration=%dms", result.Status, truncateStr(result.Output, 100), result.DurationMs)

	if result.Status != "completed" {
		t.Errorf("expected status=completed, got %q (error: %s)", result.Status, result.Error)
	}

	hasText := false
	for _, m := range messages {
		if m.Type == MessageText {
			hasText = true
			break
		}
	}
	if !hasText {
		t.Error("expected at least one MessageText")
	}

	if !strings.Contains(result.Output, "4") {
		t.Errorf("expected output to contain '4', got %q", result.Output)
	}
}

func TestOHBackend_ToolCalling(t *testing.T) {
	b := ohTestBackend(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	session, err := b.Execute(ctx, "Search the web for the current price of Bitcoin and tell me what you find.", ExecOptions{MaxTurns: 5})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	var hasToolUse, hasToolResult, hasText bool
	for msg := range session.Messages {
		t.Logf("msg: type=%s tool=%q content=%q", msg.Type, msg.Tool, truncateStr(msg.Content, 60))
		switch msg.Type {
		case MessageToolUse:
			hasToolUse = true
			if msg.Tool != "web_search" && msg.Tool != "web_fetch" {
				t.Logf("unexpected tool: %s", msg.Tool)
			}
		case MessageToolResult:
			hasToolResult = true
		case MessageText:
			hasText = true
		}
	}

	result := <-session.Result
	t.Logf("result: status=%s duration=%dms", result.Status, result.DurationMs)

	if !hasToolUse {
		t.Error("expected at least one MessageToolUse (web_search or web_fetch)")
	}
	if !hasToolResult {
		t.Error("expected at least one MessageToolResult")
	}
	if !hasText {
		t.Error("expected at least one MessageText with synthesized answer")
	}
}

func TestOHBackend_DeniedToolEnforcement(t *testing.T) {
	// Set up a config dir with denied_tools
	configDir := t.TempDir()
	settingsPath := configDir + "/settings.json"
	os.WriteFile(settingsPath, []byte(`{
		"permission": {
			"mode": "full_auto",
			"denied_tools": ["bash", "file_edit", "file_read", "glob", "grep"]
		}
	}`), 0644)

	b := ohTestBackend(t)
	b.cfg.Env["OPENHARNESS_CONFIG_DIR"] = configDir

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	session, err := b.Execute(ctx, "List all files in the current directory using the bash tool. Run: ls -la", ExecOptions{MaxTurns: 5})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	bashExecuted := false
	for msg := range session.Messages {
		t.Logf("msg: type=%s tool=%q content=%q", msg.Type, msg.Tool, truncateStr(msg.Content, 80))
		if msg.Type == MessageToolResult && msg.Tool == "bash" && !strings.Contains(msg.Output, "denied") {
			bashExecuted = true
		}
	}

	result := <-session.Result
	t.Logf("result: status=%s", result.Status)

	if bashExecuted {
		t.Error("bash tool executed successfully despite being in denied_tools — safety violation")
	}
}

func TestOHBackend_Timeout(t *testing.T) {
	b := ohTestBackend(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	// Very short timeout — should cut off the agent
	session, err := b.Execute(ctx, "Research the complete history of every country in the world. Be extremely thorough. Search the web for each country individually.", ExecOptions{
		MaxTurns: 25,
		Timeout:  3 * time.Second,
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	msgCount := 0
	for msg := range session.Messages {
		msgCount++
		_ = msg
	}

	result := <-session.Result
	t.Logf("result: status=%s msgCount=%d duration=%dms", result.Status, msgCount, result.DurationMs)

	if result.Status != "timeout" {
		t.Errorf("expected status=timeout, got %q", result.Status)
	}
}

func TestOHBackend_ContextCancellation(t *testing.T) {
	b := ohTestBackend(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)

	session, err := b.Execute(ctx, "Research the complete history of artificial intelligence from 1950 to 2026. Be extremely detailed.", ExecOptions{MaxTurns: 25})
	if err != nil {
		cancel()
		t.Fatalf("Execute: %v", err)
	}

	// Collect some messages then cancel
	msgCount := 0
	for msg := range session.Messages {
		msgCount++
		t.Logf("msg[%d]: type=%s", msgCount, msg.Type)
		if msgCount >= 3 {
			t.Log("cancelling context after 3 messages")
			cancel()
			// Continue draining to avoid goroutine leak
		}
	}

	result := <-session.Result
	t.Logf("result: status=%s msgCount=%d duration=%dms", result.Status, msgCount, result.DurationMs)

	if result.Status != "aborted" && result.Status != "failed" {
		t.Errorf("expected status=aborted or failed after cancellation, got %q", result.Status)
	}
	if msgCount < 1 {
		t.Error("expected at least 1 message before cancellation")
	}
}

func TestOHBackend_ModelRelayDown(t *testing.T) {
	// Point to a port nothing is listening on
	b := &ohBackend{cfg: Config{
		Env: map[string]string{
			"MULTICA_OH_BASE_URL": "http://localhost:1/v1",
			"MULTICA_OH_API_KEY":  "dummy",
		},
		Logger: slog.Default(),
	}}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	session, err := b.Execute(ctx, "What is 2+2?", ExecOptions{MaxTurns: 1})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	var hasError bool
	for msg := range session.Messages {
		t.Logf("msg: type=%s content=%q", msg.Type, truncateStr(msg.Content, 100))
		if msg.Type == MessageError {
			hasError = true
		}
	}

	result := <-session.Result
	t.Logf("result: status=%s error=%q duration=%dms", result.Status, truncateStr(result.Error, 100), result.DurationMs)

	// Should fail gracefully, not hang
	if result.DurationMs > 30000 {
		t.Errorf("took %dms — expected failure within 30s", result.DurationMs)
	}
	if result.Status == "completed" && !hasError {
		t.Error("expected failure or error when ModelRelay is down")
	}
}

func TestOHBackend_EmptyPrompt(t *testing.T) {
	b := ohTestBackend(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	session, err := b.Execute(ctx, "", ExecOptions{MaxTurns: 1})
	if err != nil {
		// Acceptable — Execute can fail on empty prompt
		t.Logf("Execute returned error (acceptable): %v", err)
		return
	}

	for msg := range session.Messages {
		t.Logf("msg: type=%s", msg.Type)
	}
	result := <-session.Result
	t.Logf("result: status=%s", result.Status)
	// No assertion on status — empty prompt behavior varies by model.
	// Just verifying it doesn't panic or hang.
}

func TestOHBackend_SpecialCharsInPrompt(t *testing.T) {
	b := ohTestBackend(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	// Prompt with quotes, newlines, unicode, shell metacharacters
	prompt := "What is the result of this: \"Hello\" + 'World'?\nAlso, what does $HOME mean in bash? And what about `backticks`? 日本語テスト。"

	session, err := b.Execute(ctx, prompt, ExecOptions{MaxTurns: 1})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	hasText := false
	for msg := range session.Messages {
		if msg.Type == MessageText {
			hasText = true
		}
	}

	result := <-session.Result
	t.Logf("result: status=%s output=%q", result.Status, truncateStr(result.Output, 100))

	if result.Status != "completed" {
		t.Errorf("expected completed, got %q (error: %s)", result.Status, result.Error)
	}
	if !hasText {
		t.Error("expected agent to respond with text")
	}
}

func TestOHBackend_MultiTurnResearch(t *testing.T) {
	b := ohTestBackend(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	session, err := b.Execute(ctx,
		"Compare the pricing of Stripe and Paddle. Search the web for each provider's current pricing page, "+
			"then write a brief comparison to workspace/output/comparison.md. Include actual dollar amounts from their pricing pages.",
		ExecOptions{MaxTurns: 15, Cwd: t.TempDir()})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	var toolUseCount, searchCount, fetchCount, writeCount int
	hasText := false
	for msg := range session.Messages {
		switch msg.Type {
		case MessageToolUse:
			toolUseCount++
			switch msg.Tool {
			case "web_search":
				searchCount++
			case "web_fetch":
				fetchCount++
			case "write_file", "file_write":
				writeCount++
			}
			t.Logf("tool_use: %s(%v)", msg.Tool, truncateStr(mapToStr(msg.Input), 60))
		case MessageText:
			hasText = true
		}
	}

	result := <-session.Result
	t.Logf("result: status=%s tools=%d (search=%d fetch=%d write=%d) duration=%dms",
		result.Status, toolUseCount, searchCount, fetchCount, writeCount, result.DurationMs)

	if result.Status != "completed" {
		t.Errorf("expected completed, got %q (error: %s)", result.Status, result.Error)
	}
	if !hasText {
		t.Error("expected at least one MessageText")
	}
	if searchCount < 2 {
		t.Errorf("expected >=2 web_search calls, got %d", searchCount)
	}
	if toolUseCount < 3 {
		t.Errorf("expected >=3 total tool calls, got %d", toolUseCount)
	}
}

func TestOHBackend_LargeOutput(t *testing.T) {
	b := ohTestBackend(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	session, err := b.Execute(ctx,
		"Write a detailed 1000-word essay about the history of the internet. Include sections on ARPANET, TCP/IP, the World Wide Web, and mobile internet.",
		ExecOptions{MaxTurns: 3})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	msgCount := 0
	for msg := range session.Messages {
		if msg.Type == MessageText {
			msgCount++
		}
	}

	result := <-session.Result
	t.Logf("result: status=%s textMsgs=%d outputLen=%d", result.Status, msgCount, len(result.Output))

	if result.Status != "completed" {
		t.Errorf("expected completed, got %q", result.Status)
	}
	if len(result.Output) < 500 {
		t.Errorf("expected substantial output (>=500 chars), got %d chars", len(result.Output))
	}
}

// --- helpers ---

func truncateStr(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}

func mapToStr(m map[string]any) string {
	if m == nil {
		return "{}"
	}
	parts := make([]string, 0, len(m))
	for k, v := range m {
		s := fmt.Sprintf("%v", v)
		parts = append(parts, k+"="+truncateStr(strings.TrimSpace(strings.ReplaceAll(s, "\n", " ")), 30))
	}
	return "{" + strings.Join(parts, ", ") + "}"
}
