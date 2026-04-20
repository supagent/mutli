package cloud

import (
	"encoding/json"
	"strings"

	"github.com/multica-ai/multica/server/pkg/agent"
)

// ndEvent represents a single NDJSON event from the ADK agent bridge.
type ndEvent struct {
	Type    string                       `json:"type"`
	Seq     int                          `json:"seq,omitempty"`
	Tool    string                       `json:"tool,omitempty"`
	Input   map[string]any               `json:"input,omitempty"`
	Output  string                       `json:"output,omitempty"`
	Content string                       `json:"content,omitempty"`
	Status  string                       `json:"status,omitempty"`
	Error   string                       `json:"error,omitempty"`
	Usage   map[string]ndEventTokenUsage `json:"usage,omitempty"`
	TaskID  string                       `json:"task_id,omitempty"`
	IssueID string                       `json:"issue_id,omitempty"`
}

// ndEventTokenUsage maps the JSON token usage fields from the bridge.
type ndEventTokenUsage struct {
	InputTokens      int64 `json:"input_tokens"`
	OutputTokens     int64 `json:"output_tokens"`
	CacheReadTokens  int64 `json:"cache_read_tokens"`
	CacheWriteTokens int64 `json:"cache_write_tokens"`
}

// ParseNDJSONLine parses a single NDJSON line from the ADK agent's stdout
// into either an agent.Message or an agent.Result.
//
// For "result" events, msg is zero-valued and result is non-nil.
// For all other recognized events, result is nil and msg is populated.
// Returns ok=false for unrecognized, empty, or malformed lines.
func ParseNDJSONLine(raw string) (msg agent.Message, result *agent.Result, ok bool) {
	line := stripANSI(raw)
	line = normalizeLineEndings(line)
	line = strings.TrimSpace(line)

	if line == "" || line[0] != '{' {
		return agent.Message{}, nil, false
	}

	var ev ndEvent
	if err := json.Unmarshal([]byte(line), &ev); err != nil {
		return agent.Message{}, nil, false
	}

	switch ev.Type {
	case "tool_use":
		return agent.Message{
			Type:  agent.MessageToolUse,
			Tool:  ev.Tool,
			Input: ev.Input,
		}, nil, true

	case "tool_result":
		return agent.Message{
			Type:   agent.MessageToolResult,
			Tool:   ev.Tool,
			Output: ev.Output,
		}, nil, true

	case "text":
		return agent.Message{
			Type:    agent.MessageText,
			Content: ev.Content,
		}, nil, true

	case "thinking":
		return agent.Message{
			Type:    agent.MessageThinking,
			Content: ev.Content,
		}, nil, true

	case "error":
		return agent.Message{
			Type:    agent.MessageError,
			Content: ev.Content,
		}, nil, true

	case "result":
		usage := make(map[string]agent.TokenUsage, len(ev.Usage))
		for model, u := range ev.Usage {
			usage[model] = agent.TokenUsage{
				InputTokens:      u.InputTokens,
				OutputTokens:     u.OutputTokens,
				CacheReadTokens:  u.CacheReadTokens,
				CacheWriteTokens: u.CacheWriteTokens,
			}
		}
		return agent.Message{}, &agent.Result{
			Status: ev.Status,
			Output: ev.Output,
			Error:  ev.Error,
			Usage:  usage,
		}, true

	default:
		return agent.Message{}, nil, false
	}
}
