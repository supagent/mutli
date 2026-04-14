package agent

import (
	"os"
	"testing"
)

func TestBuildOHArgs_Defaults(t *testing.T) {
	t.Setenv("MULTICA_OH_BASE_URL", "")
	t.Setenv("MULTICA_OH_API_KEY", "")
	t.Setenv("MULTICA_OH_MODEL", "")

	args := buildOHArgs("hello", ExecOptions{}, nil)

	assertContains(t, args, "-p", "hello")
	assertContains(t, args, "--output-format", "stream-json")
	assertContains(t, args, "--api-format", "openai")
	assertContains(t, args, "--base-url", "http://localhost:7352/v1")
	assertContains(t, args, "--api-key", "dummy")
	assertContains(t, args, "--model", "auto-fastest")
	assertContains(t, args, "--max-turns", "25")
	assertContains(t, args, "--permission-mode", "full_auto")
	assertContains(t, args, "--bare")
}

func TestBuildOHArgs_WithOverrides(t *testing.T) {
	opts := ExecOptions{
		Model:        "kimi-k2.5",
		MaxTurns:     10,
		SystemPrompt: "You are a research assistant.",
	}
	args := buildOHArgs("test prompt", opts, nil)

	assertContains(t, args, "--model", "kimi-k2.5")
	assertContains(t, args, "--max-turns", "10")
	assertContains(t, args, "--append-system-prompt", "You are a research assistant.")
}

func TestBuildOHArgs_BaseURLFromEnv(t *testing.T) {
	env := map[string]string{
		"MULTICA_OH_BASE_URL": "https://openrouter.ai/api/v1",
		"MULTICA_OH_API_KEY":  "sk-or-test",
		"MULTICA_OH_MODEL":    "anthropic/claude-sonnet-4",
	}
	args := buildOHArgs("hello", ExecOptions{}, env)

	assertContains(t, args, "--base-url", "https://openrouter.ai/api/v1")
	assertContains(t, args, "--api-key", "sk-or-test")
	assertContains(t, args, "--model", "anthropic/claude-sonnet-4")
}

func TestBuildOHArgs_OptsModelOverridesEnv(t *testing.T) {
	env := map[string]string{"MULTICA_OH_MODEL": "auto-fastest"}
	opts := ExecOptions{Model: "deepseek-v3.2"}
	args := buildOHArgs("hello", opts, env)

	assertContains(t, args, "--model", "deepseek-v3.2")
}

func TestBuildOHEnv_MergesParentEnv(t *testing.T) {
	env := buildOHEnv(map[string]string{"CUSTOM_VAR": "custom_value"})
	found := false
	for _, e := range env {
		if e == "CUSTOM_VAR=custom_value" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected CUSTOM_VAR=custom_value in env")
	}

	// Should also contain inherited env vars like PATH
	hasPath := false
	for _, e := range env {
		if len(e) > 5 && e[:5] == "PATH=" {
			hasPath = true
			break
		}
	}
	if !hasPath {
		t.Error("expected PATH in env")
	}
}

func TestBuildOHEnv_ConfigDir(t *testing.T) {
	env := buildOHEnv(map[string]string{
		"OPENHARNESS_CONFIG_DIR": "/etc/multica-agent",
	})
	found := false
	for _, e := range env {
		if e == "OPENHARNESS_CONFIG_DIR=/etc/multica-agent" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected OPENHARNESS_CONFIG_DIR=/etc/multica-agent in env")
	}
}

func TestResolveOHModel_Priority(t *testing.T) {
	t.Setenv("MULTICA_OH_MODEL", "")

	// opts.Model takes priority
	if m := resolveOHModel(ExecOptions{Model: "a"}, map[string]string{"MULTICA_OH_MODEL": "b"}); m != "a" {
		t.Errorf("expected opts.Model to win, got %q", m)
	}
	// then env map
	if m := resolveOHModel(ExecOptions{}, map[string]string{"MULTICA_OH_MODEL": "b"}); m != "b" {
		t.Errorf("expected env map to win, got %q", m)
	}
	// then default
	if m := resolveOHModel(ExecOptions{}, nil); m != "auto-fastest" {
		t.Errorf("expected default, got %q", m)
	}
}

func TestParseOHLine_AllEventTypes(t *testing.T) {
	tests := []struct {
		name    string
		line    string
		wantOK  bool
		wantTyp MessageType
	}{
		{"assistant_delta", `{"type":"assistant_delta","text":"Hello"}`, true, MessageText},
		{"assistant_complete", `{"type":"assistant_complete","text":"Done"}`, true, MessageText},
		{"tool_started", `{"type":"tool_started","tool_name":"web_search","tool_input":{"query":"test"}}`, true, MessageToolUse},
		{"tool_completed", `{"type":"tool_completed","tool_name":"web_search","output":"results","is_error":false}`, true, MessageToolResult},
		{"error", `{"type":"error","message":"something broke","recoverable":true}`, true, MessageError},
		{"status", `{"type":"status","message":"running"}`, true, MessageStatus},
		{"system", `{"type":"system","message":"starting"}`, true, MessageLog},
		{"compact_progress", `{"type":"compact_progress","phase":"compact_start","trigger":"auto"}`, true, MessageStatus},
		{"unknown", `{"type":"unknown_event"}`, false, ""},
		{"empty", "", false, ""},
		{"not_json", "root@sandbox:~# ", false, ""},
		{"ansi_wrapped", "\x1b[?2004l\r{\"type\":\"assistant_delta\",\"text\":\"4\"}\r\n", true, MessageText},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			msg, ok := parseOHLine(tt.line)
			if ok != tt.wantOK {
				t.Fatalf("parseOHLine() ok = %v, want %v", ok, tt.wantOK)
			}
			if ok && msg.Type != tt.wantTyp {
				t.Errorf("type = %q, want %q", msg.Type, tt.wantTyp)
			}
		})
	}
}

func TestParseOHLine_ToolInput(t *testing.T) {
	msg, ok := parseOHLine(`{"type":"tool_started","tool_name":"web_search","tool_input":{"query":"bitcoin price","max_results":5}}`)
	if !ok {
		t.Fatal("expected ok")
	}
	if msg.Tool != "web_search" {
		t.Errorf("tool = %q", msg.Tool)
	}
	if msg.Input["query"] != "bitcoin price" {
		t.Errorf("input = %v", msg.Input)
	}
}

func TestEnvOr_Priority(t *testing.T) {
	// env map wins
	if v := envOr(map[string]string{"K": "from_map"}, "K", "default"); v != "from_map" {
		t.Errorf("expected from_map, got %q", v)
	}
	// os env wins over default
	os.Setenv("TEST_ENVOR_KEY", "from_os")
	defer os.Unsetenv("TEST_ENVOR_KEY")
	if v := envOr(nil, "TEST_ENVOR_KEY", "default"); v != "from_os" {
		t.Errorf("expected from_os, got %q", v)
	}
	// default
	if v := envOr(nil, "NONEXISTENT_KEY_XYZ", "fallback"); v != "fallback" {
		t.Errorf("expected fallback, got %q", v)
	}
}

// --- helpers ---

func assertContains(t *testing.T, args []string, key string, optionalValue ...string) {
	t.Helper()
	for i, a := range args {
		if a == key {
			if len(optionalValue) == 0 {
				return // flag found, no value check needed
			}
			if i+1 < len(args) && args[i+1] == optionalValue[0] {
				return
			}
			t.Errorf("args has %q but next value is %q, want %q", key, args[i+1], optionalValue[0])
			return
		}
	}
	if len(optionalValue) > 0 {
		t.Errorf("args missing %q %q", key, optionalValue[0])
	} else {
		t.Errorf("args missing %q", key)
	}
}
