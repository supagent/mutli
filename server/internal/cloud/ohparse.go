package cloud

import (
	"encoding/json"
	"regexp"
	"strings"

	"github.com/multica-ai/multica/server/pkg/agent"
)

// ansiRe matches ANSI CSI sequences (e.g. \x1b[32m, \x1b[?2004l) and OSC sequences (e.g. \x1b]0;...\a).
var ansiRe = regexp.MustCompile(`\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07]*\x07)`)

// stripANSI removes all ANSI escape sequences from s.
func stripANSI(s string) string {
	return ansiRe.ReplaceAllString(s, "")
}

// normalizeLineEndings replaces \r\n with \n and strips trailing \r.
func normalizeLineEndings(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.TrimRight(s, "\r")
	return s
}

// ohEvent represents a single OpenHarness stream-json event.
// Field names match the JSON keys emitted by OH's --output-format stream-json.
type ohEvent struct {
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`       // assistant_delta, assistant_complete
	ToolName  string          `json:"tool_name,omitempty"`  // tool_started, tool_completed
	ToolInput json.RawMessage `json:"tool_input,omitempty"` // tool_started
	Output    string          `json:"output,omitempty"`     // tool_completed
	IsError   bool            `json:"is_error,omitempty"`   // tool_completed
	Message   string          `json:"message,omitempty"`    // error, status, system, compact_progress
	Phase     string          `json:"phase,omitempty"`      // compact_progress
}

// mapOHEvent converts an ohEvent to an agent.Message.
// Returns false if the event type is unknown or should be skipped.
func mapOHEvent(ev ohEvent) (agent.Message, bool) {
	switch ev.Type {
	case "assistant_delta":
		return agent.Message{Type: agent.MessageText, Content: ev.Text}, true
	case "assistant_complete":
		return agent.Message{Type: agent.MessageText, Content: ev.Text}, true
	case "tool_started":
		var input map[string]any
		if len(ev.ToolInput) > 0 {
			_ = json.Unmarshal(ev.ToolInput, &input)
		}
		return agent.Message{Type: agent.MessageToolUse, Tool: ev.ToolName, Input: input}, true
	case "tool_completed":
		return agent.Message{Type: agent.MessageToolResult, Tool: ev.ToolName, Output: ev.Output}, true
	case "error":
		return agent.Message{Type: agent.MessageError, Content: ev.Message}, true
	case "status":
		return agent.Message{Type: agent.MessageStatus, Status: ev.Message}, true
	case "system":
		return agent.Message{Type: agent.MessageLog, Content: ev.Message, Level: "info"}, true
	case "compact_progress":
		msg := ev.Message
		if msg == "" {
			msg = ev.Phase
		}
		return agent.Message{Type: agent.MessageStatus, Status: msg}, true
	default:
		return agent.Message{}, false
	}
}

// ParseOHLine parses a raw PTY output line into an agent.Message.
// It strips ANSI codes, normalizes line endings, and attempts JSON parsing.
// Returns false if the line is not valid OH stream-json.
func ParseOHLine(raw string) (agent.Message, bool) {
	line := stripANSI(raw)
	line = normalizeLineEndings(line)
	line = strings.TrimSpace(line)
	if line == "" || line[0] != '{' {
		return agent.Message{}, false
	}
	var ev ohEvent
	if err := json.Unmarshal([]byte(line), &ev); err != nil {
		return agent.Message{}, false
	}
	return mapOHEvent(ev)
}
