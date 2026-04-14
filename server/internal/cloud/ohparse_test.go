package cloud

import (
	"testing"

	"github.com/multica-ai/multica/server/pkg/agent"
)

func TestStripANSI(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"empty", "", ""},
		{"no escape", "hello world", "hello world"},
		{"SGR color", "\x1b[32mhello\x1b[0m", "hello"},
		{"cursor move", "\x1b[2Ahello", "hello"},
		{"bracketed paste", "\x1b[?2004lhello\x1b[?2004h", "hello"},
		{"OSC title", "\x1b]0;root@sandbox: ~\x07hello", "hello"},
		{"clear line", "hello\x1b[K world", "hello world"},
		{"mixed", "\x1b[?2004l\r\x1b[32mline 1\x1b[0m", "\rline 1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := stripANSI(tt.input)
			if got != tt.want {
				t.Errorf("stripANSI(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestNormalizeLineEndings(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"empty", "", ""},
		{"lf only", "hello\nworld", "hello\nworld"},
		{"crlf", "hello\r\nworld", "hello\nworld"},
		{"trailing cr", "hello\r", "hello"},
		{"mixed", "a\r\nb\nc\r", "a\nb\nc"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := normalizeLineEndings(tt.input)
			if got != tt.want {
				t.Errorf("normalizeLineEndings(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestParseOHLine_AssistantDelta(t *testing.T) {
	msg, ok := ParseOHLine(`{"type": "assistant_delta", "text": "Hello"}`)
	if !ok {
		t.Fatal("expected ok")
	}
	if msg.Type != agent.MessageText {
		t.Errorf("type = %q, want %q", msg.Type, agent.MessageText)
	}
	if msg.Content != "Hello" {
		t.Errorf("content = %q, want %q", msg.Content, "Hello")
	}
}

func TestParseOHLine_AssistantComplete(t *testing.T) {
	msg, ok := ParseOHLine(`{"type": "assistant_complete", "text": "Done"}`)
	if !ok {
		t.Fatal("expected ok")
	}
	if msg.Type != agent.MessageText || msg.Content != "Done" {
		t.Errorf("got %+v", msg)
	}
}

func TestParseOHLine_ToolStarted(t *testing.T) {
	msg, ok := ParseOHLine(`{"type": "tool_started", "tool_name": "bash", "tool_input": {"command": "ls"}}`)
	if !ok {
		t.Fatal("expected ok")
	}
	if msg.Type != agent.MessageToolUse {
		t.Errorf("type = %q, want %q", msg.Type, agent.MessageToolUse)
	}
	if msg.Tool != "bash" {
		t.Errorf("tool = %q, want %q", msg.Tool, "bash")
	}
	if msg.Input["command"] != "ls" {
		t.Errorf("input = %v, want command=ls", msg.Input)
	}
}

func TestParseOHLine_ToolCompleted(t *testing.T) {
	msg, ok := ParseOHLine(`{"type": "tool_completed", "tool_name": "bash", "output": "file.txt", "is_error": false}`)
	if !ok {
		t.Fatal("expected ok")
	}
	if msg.Type != agent.MessageToolResult || msg.Tool != "bash" || msg.Output != "file.txt" {
		t.Errorf("got %+v", msg)
	}
}

func TestParseOHLine_Error(t *testing.T) {
	msg, ok := ParseOHLine(`{"type": "error", "message": "something broke", "recoverable": true}`)
	if !ok {
		t.Fatal("expected ok")
	}
	if msg.Type != agent.MessageError || msg.Content != "something broke" {
		t.Errorf("got %+v", msg)
	}
}

func TestParseOHLine_Status(t *testing.T) {
	msg, ok := ParseOHLine(`{"type": "status", "message": "running"}`)
	if !ok {
		t.Fatal("expected ok")
	}
	if msg.Type != agent.MessageStatus || msg.Status != "running" {
		t.Errorf("got %+v", msg)
	}
}

func TestParseOHLine_System(t *testing.T) {
	msg, ok := ParseOHLine(`{"type": "system", "message": "starting agent"}`)
	if !ok {
		t.Fatal("expected ok")
	}
	if msg.Type != agent.MessageLog || msg.Content != "starting agent" || msg.Level != "info" {
		t.Errorf("got %+v", msg)
	}
}

func TestParseOHLine_WithANSI(t *testing.T) {
	// JSON line wrapped in ANSI escape codes (as from PTY)
	line := "\x1b[?2004l\r{\"type\": \"assistant_delta\", \"text\": \"4\"}\r\n"
	msg, ok := ParseOHLine(line)
	if !ok {
		t.Fatal("expected ok")
	}
	if msg.Type != agent.MessageText || msg.Content != "4" {
		t.Errorf("got %+v", msg)
	}
}

func TestParseOHLine_InvalidJSON(t *testing.T) {
	_, ok := ParseOHLine("this is not json")
	if ok {
		t.Error("expected not ok for non-JSON")
	}
}

func TestParseOHLine_UnknownType(t *testing.T) {
	_, ok := ParseOHLine(`{"type": "unknown_event", "data": "foo"}`)
	if ok {
		t.Error("expected not ok for unknown type")
	}
}

func TestParseOHLine_EmptyLine(t *testing.T) {
	_, ok := ParseOHLine("")
	if ok {
		t.Error("expected not ok for empty line")
	}
}

func TestParseOHLine_ShellPrompt(t *testing.T) {
	_, ok := ParseOHLine("root@sandbox:~# ")
	if ok {
		t.Error("expected not ok for shell prompt")
	}
}
