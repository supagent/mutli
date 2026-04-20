package cloud

import (
	"testing"

	"github.com/multica-ai/multica/server/pkg/agent"
)

func TestParseNDJSONLine_ToolUse(t *testing.T) {
	raw := `{"type":"tool_use","seq":1,"tool":"get_issue","input":{"issue_id":"ISS-42"},"task_id":"t1"}`
	msg, result, ok := ParseNDJSONLine(raw)
	if !ok {
		t.Fatal("expected ok=true for tool_use")
	}
	if result != nil {
		t.Fatal("expected result=nil for tool_use")
	}
	if msg.Type != agent.MessageToolUse {
		t.Fatalf("expected type %q, got %q", agent.MessageToolUse, msg.Type)
	}
	if msg.Tool != "get_issue" {
		t.Fatalf("expected tool %q, got %q", "get_issue", msg.Tool)
	}
	if msg.Input["issue_id"] != "ISS-42" {
		t.Fatalf("expected input issue_id=ISS-42, got %v", msg.Input["issue_id"])
	}
}

func TestParseNDJSONLine_ToolResult(t *testing.T) {
	raw := `{"type":"tool_result","seq":2,"tool":"get_issue","output":"found it","task_id":"t1"}`
	msg, result, ok := ParseNDJSONLine(raw)
	if !ok {
		t.Fatal("expected ok=true for tool_result")
	}
	if result != nil {
		t.Fatal("expected result=nil for tool_result")
	}
	if msg.Type != agent.MessageToolResult {
		t.Fatalf("expected type %q, got %q", agent.MessageToolResult, msg.Type)
	}
	if msg.Tool != "get_issue" {
		t.Fatalf("expected tool %q, got %q", "get_issue", msg.Tool)
	}
	if msg.Output != "found it" {
		t.Fatalf("expected output %q, got %q", "found it", msg.Output)
	}
}

func TestParseNDJSONLine_Text(t *testing.T) {
	raw := `{"type":"text","seq":3,"content":"Hello world","task_id":"t1"}`
	msg, result, ok := ParseNDJSONLine(raw)
	if !ok {
		t.Fatal("expected ok=true for text")
	}
	if result != nil {
		t.Fatal("expected result=nil for text")
	}
	if msg.Type != agent.MessageText {
		t.Fatalf("expected type %q, got %q", agent.MessageText, msg.Type)
	}
	if msg.Content != "Hello world" {
		t.Fatalf("expected content %q, got %q", "Hello world", msg.Content)
	}
}

func TestParseNDJSONLine_Thinking(t *testing.T) {
	raw := `{"type":"thinking","seq":4,"content":"Let me analyze...","task_id":"t1"}`
	msg, result, ok := ParseNDJSONLine(raw)
	if !ok {
		t.Fatal("expected ok=true for thinking")
	}
	if result != nil {
		t.Fatal("expected result=nil for thinking")
	}
	if msg.Type != agent.MessageThinking {
		t.Fatalf("expected type %q, got %q", agent.MessageThinking, msg.Type)
	}
	if msg.Content != "Let me analyze..." {
		t.Fatalf("expected content %q, got %q", "Let me analyze...", msg.Content)
	}
}

func TestParseNDJSONLine_Error(t *testing.T) {
	raw := `{"type":"error","seq":5,"content":"something broke","task_id":"t1"}`
	msg, result, ok := ParseNDJSONLine(raw)
	if !ok {
		t.Fatal("expected ok=true for error")
	}
	if result != nil {
		t.Fatal("expected result=nil for error")
	}
	if msg.Type != agent.MessageError {
		t.Fatalf("expected type %q, got %q", agent.MessageError, msg.Type)
	}
	if msg.Content != "something broke" {
		t.Fatalf("expected content %q, got %q", "something broke", msg.Content)
	}
}

func TestParseNDJSONLine_ResultCompleted(t *testing.T) {
	raw := `{"type":"result","status":"completed","output":"done","usage":{"gemini-2.5-flash":{"input_tokens":500,"output_tokens":200,"cache_read_tokens":50,"cache_write_tokens":0}},"task_id":"t1"}`
	msg, result, ok := ParseNDJSONLine(raw)
	if !ok {
		t.Fatal("expected ok=true for result")
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	// msg should be zero value for result type
	if msg.Type != "" {
		t.Fatalf("expected empty msg type for result, got %q", msg.Type)
	}
	if result.Status != "completed" {
		t.Fatalf("expected status %q, got %q", "completed", result.Status)
	}
	if result.Output != "done" {
		t.Fatalf("expected output %q, got %q", "done", result.Output)
	}
	usage, exists := result.Usage["gemini-2.5-flash"]
	if !exists {
		t.Fatal("expected usage entry for gemini-2.5-flash")
	}
	if usage.InputTokens != 500 {
		t.Fatalf("expected input_tokens=500, got %d", usage.InputTokens)
	}
	if usage.OutputTokens != 200 {
		t.Fatalf("expected output_tokens=200, got %d", usage.OutputTokens)
	}
	if usage.CacheReadTokens != 50 {
		t.Fatalf("expected cache_read_tokens=50, got %d", usage.CacheReadTokens)
	}
	if usage.CacheWriteTokens != 0 {
		t.Fatalf("expected cache_write_tokens=0, got %d", usage.CacheWriteTokens)
	}
}

func TestParseNDJSONLine_ResultFailed(t *testing.T) {
	raw := `{"type":"result","status":"failed","output":"","error":"out of tokens","usage":{},"task_id":"t1"}`
	_, result, ok := ParseNDJSONLine(raw)
	if !ok {
		t.Fatal("expected ok=true for failed result")
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.Status != "failed" {
		t.Fatalf("expected status %q, got %q", "failed", result.Status)
	}
	if result.Error != "out of tokens" {
		t.Fatalf("expected error %q, got %q", "out of tokens", result.Error)
	}
}

func TestParseNDJSONLine_MalformedJSON(t *testing.T) {
	_, _, ok := ParseNDJSONLine(`{not valid json`)
	if ok {
		t.Fatal("expected ok=false for malformed JSON")
	}
}

func TestParseNDJSONLine_EmptyLine(t *testing.T) {
	_, _, ok := ParseNDJSONLine("")
	if ok {
		t.Fatal("expected ok=false for empty line")
	}
}

func TestParseNDJSONLine_WhitespaceOnly(t *testing.T) {
	_, _, ok := ParseNDJSONLine("   \t  ")
	if ok {
		t.Fatal("expected ok=false for whitespace-only line")
	}
}

func TestParseNDJSONLine_ANSIEscapeCodes(t *testing.T) {
	// Wrap valid JSON with ANSI color codes
	raw := "\x1b[32m" + `{"type":"text","seq":1,"content":"green text","task_id":"t1"}` + "\x1b[0m"
	msg, _, ok := ParseNDJSONLine(raw)
	if !ok {
		t.Fatal("expected ok=true after stripping ANSI")
	}
	if msg.Type != agent.MessageText {
		t.Fatalf("expected type %q, got %q", agent.MessageText, msg.Type)
	}
	if msg.Content != "green text" {
		t.Fatalf("expected content %q, got %q", "green text", msg.Content)
	}
}

func TestParseNDJSONLine_ShellPromptDollar(t *testing.T) {
	_, _, ok := ParseNDJSONLine(`$ python multica_agent.py`)
	if ok {
		t.Fatal("expected ok=false for shell prompt line starting with $")
	}
}

func TestParseNDJSONLine_ShellPromptDaytona(t *testing.T) {
	_, _, ok := ParseNDJSONLine(`daytona@workspace:~$ python multica_agent.py`)
	if ok {
		t.Fatal("expected ok=false for daytona shell prompt")
	}
}

func TestParseNDJSONLine_NonJSONText(t *testing.T) {
	_, _, ok := ParseNDJSONLine(`This is just a plain text line`)
	if ok {
		t.Fatal("expected ok=false for non-JSON text")
	}
}

func TestParseNDJSONLine_UnknownType(t *testing.T) {
	raw := `{"type":"unknown_event","seq":1,"content":"something"}`
	_, _, ok := ParseNDJSONLine(raw)
	if ok {
		t.Fatal("expected ok=false for unknown event type")
	}
}

func TestParseNDJSONLine_ResultWithMultipleModels(t *testing.T) {
	raw := `{"type":"result","status":"completed","output":"done","usage":{"gemini-2.5-flash":{"input_tokens":100,"output_tokens":50,"cache_read_tokens":10,"cache_write_tokens":5},"gemini-2.5-pro":{"input_tokens":200,"output_tokens":100,"cache_read_tokens":20,"cache_write_tokens":10}}}`
	_, result, ok := ParseNDJSONLine(raw)
	if !ok {
		t.Fatal("expected ok=true")
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if len(result.Usage) != 2 {
		t.Fatalf("expected 2 usage entries, got %d", len(result.Usage))
	}
	flash := result.Usage["gemini-2.5-flash"]
	if flash.InputTokens != 100 {
		t.Fatalf("expected flash input_tokens=100, got %d", flash.InputTokens)
	}
	pro := result.Usage["gemini-2.5-pro"]
	if pro.InputTokens != 200 {
		t.Fatalf("expected pro input_tokens=200, got %d", pro.InputTokens)
	}
}

func TestParseNDJSONLine_ResultEmptyUsage(t *testing.T) {
	raw := `{"type":"result","status":"completed","output":"done","usage":{}}`
	_, result, ok := ParseNDJSONLine(raw)
	if !ok {
		t.Fatal("expected ok=true")
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if len(result.Usage) != 0 {
		t.Fatalf("expected empty usage map, got %d entries", len(result.Usage))
	}
}

func TestParseNDJSONLine_ANSIWithBracketCodes(t *testing.T) {
	// OSC sequence + CSI sequence wrapping JSON
	raw := "\x1b]0;title\x07\x1b[?2004l" + `{"type":"text","seq":1,"content":"hello"}` + "\x1b[?2004h"
	msg, _, ok := ParseNDJSONLine(raw)
	if !ok {
		t.Fatal("expected ok=true after stripping complex ANSI")
	}
	if msg.Content != "hello" {
		t.Fatalf("expected content %q, got %q", "hello", msg.Content)
	}
}
