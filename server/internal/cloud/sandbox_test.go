package cloud

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/agent"
)

// drainLineBuffer simulates the PTY line buffer logic by feeding chunks
// through drainPTYData and collecting parsed messages.
func drainLineBuffer(chunks []string) ([]agent.Message, string, string) {
	msgCh := make(chan agent.Message, 256)
	dataCh := make(chan []byte, len(chunks))
	for _, c := range chunks {
		dataCh <- []byte(c)
	}
	close(dataCh)

	var textOutput, toolOutput strings.Builder
	drainPTYData(context.Background(), dataCh, msgCh, &textOutput, &toolOutput)
	close(msgCh)

	var msgs []agent.Message
	for m := range msgCh {
		msgs = append(msgs, m)
	}
	return msgs, textOutput.String(), toolOutput.String()
}

func TestLineBuffer_SingleComplete(t *testing.T) {
	msgs, output, _ := drainLineBuffer([]string{
		"{\"type\": \"assistant_delta\", \"text\": \"Hello\"}\n",
	})
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].Type != agent.MessageText || msgs[0].Content != "Hello" {
		t.Errorf("unexpected message: %+v", msgs[0])
	}
	if output != "Hello" {
		t.Errorf("expected output 'Hello', got %q", output)
	}
}

func TestLineBuffer_SplitAcrossChunks(t *testing.T) {
	msgs, _, _ := drainLineBuffer([]string{
		"{\"type\": \"assistant_del",
		"ta\", \"text\": \"Split\"}\n",
	})
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].Content != "Split" {
		t.Errorf("expected content 'Split', got %q", msgs[0].Content)
	}
}

func TestLineBuffer_MultipleInOneChunk(t *testing.T) {
	msgs, output, _ := drainLineBuffer([]string{
		"{\"type\": \"assistant_delta\", \"text\": \"A\"}\n{\"type\": \"assistant_delta\", \"text\": \"B\"}\n",
	})
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	if msgs[0].Content != "A" || msgs[1].Content != "B" {
		t.Errorf("unexpected messages: %+v, %+v", msgs[0], msgs[1])
	}
	if output != "AB" {
		t.Errorf("expected output 'AB', got %q", output)
	}
}

func TestLineBuffer_ANSIWrapped(t *testing.T) {
	msgs, _, _ := drainLineBuffer([]string{
		"\x1b[?2004l\r{\"type\": \"assistant_delta\", \"text\": \"4\"}\r\n",
	})
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].Content != "4" {
		t.Errorf("expected content '4', got %q", msgs[0].Content)
	}
}

func TestLineBuffer_NonJSONSkipped(t *testing.T) {
	msgs, _, _ := drainLineBuffer([]string{
		"root@sandbox:~# \n",
		"oh -p \"hello\" --output-format stream-json\n",
		"{\"type\": \"assistant_delta\", \"text\": \"Hi\"}\n",
		"exit\n",
	})
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message (non-JSON skipped), got %d", len(msgs))
	}
	if msgs[0].Content != "Hi" {
		t.Errorf("expected content 'Hi', got %q", msgs[0].Content)
	}
}

func TestLineBuffer_EmptyChunks(t *testing.T) {
	msgs, _, _ := drainLineBuffer([]string{
		"",
		"",
		"{\"type\": \"assistant_delta\", \"text\": \"Ok\"}\n",
		"",
	})
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
}

func TestLineBuffer_FlushRemaining(t *testing.T) {
	msgs, _, _ := drainLineBuffer([]string{
		"{\"type\": \"assistant_delta\", \"text\": \"Partial\"}",
	})
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message from flush, got %d", len(msgs))
	}
	if msgs[0].Content != "Partial" {
		t.Errorf("expected content 'Partial', got %q", msgs[0].Content)
	}
}

func TestLineBuffer_ContextCancellation(t *testing.T) {
	msgCh := make(chan agent.Message, 256)
	dataCh := make(chan []byte, 10)

	// Buffer a message BEFORE creating context so it's available on first select
	dataCh <- []byte("{\"type\": \"assistant_delta\", \"text\": \"Before\"}\n")

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately — drainPTYData should still not hang

	var textOutput, toolOutput strings.Builder
	done := make(chan struct{})
	go func() {
		drainPTYData(ctx, dataCh, msgCh, &textOutput, &toolOutput)
		close(done)
	}()

	// Must complete within 2 seconds (proves no infinite hang)
	select {
	case <-done:
		// good
	case <-time.After(2 * time.Second):
		t.Fatal("drainPTYData hung after context cancellation")
	}
	close(msgCh)

	var msgs []agent.Message
	for m := range msgCh {
		msgs = append(msgs, m)
	}
	t.Logf("got %d messages after context cancel", len(msgs))
	// With cancelled context, drainPTYData may or may not process the buffered
	// message (depends on select ordering). The key assertion is it doesn't hang.
}

func TestLineBuffer_OutputAccumulation(t *testing.T) {
	msgs, output, _ := drainLineBuffer([]string{
		"{\"type\": \"assistant_delta\", \"text\": \"Part 1\"}\n",
		"{\"type\": \"tool_started\", \"tool_name\": \"web_search\", \"tool_input\": {\"query\": \"test\"}}\n",
		"{\"type\": \"assistant_delta\", \"text\": \" Part 2\"}\n",
	})
	if len(msgs) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(msgs))
	}
	// Output should only contain text messages, not tool events
	if output != "Part 1 Part 2" {
		t.Errorf("expected output 'Part 1 Part 2', got %q", output)
	}
}

func TestLineBuffer_ToolOutputFallback(t *testing.T) {
	// When no text messages exist, tool output should be collected as fallback
	msgs, textOutput, toolOutput := drainLineBuffer([]string{
		"{\"type\": \"tool_started\", \"tool_name\": \"web_search\", \"tool_input\": {\"query\": \"test\"}}\n",
		"{\"type\": \"tool_completed\", \"tool_name\": \"web_search\", \"output\": \"Result: found 5 items\", \"is_error\": false}\n",
		"{\"type\": \"tool_started\", \"tool_name\": \"web_fetch\", \"tool_input\": {\"url\": \"https://example.com\"}}\n",
		"{\"type\": \"tool_completed\", \"tool_name\": \"web_fetch\", \"output\": \"Page content here\", \"is_error\": false}\n",
	})
	if len(msgs) != 4 {
		t.Fatalf("expected 4 messages, got %d", len(msgs))
	}
	// No text output (no assistant_delta/complete events)
	if textOutput != "" {
		t.Errorf("expected empty text output, got %q", textOutput)
	}
	// Tool output should contain both results
	if !strings.Contains(toolOutput, "Result: found 5 items") {
		t.Errorf("tool output missing first result: %q", toolOutput)
	}
	if !strings.Contains(toolOutput, "Page content here") {
		t.Errorf("tool output missing second result: %q", toolOutput)
	}
}

func TestShellQuote(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"simple", "'simple'"},
		{"it's here", "'it'\\''s here'"},
		{"", "''"},
		{"hello world", "'hello world'"},
		{"$(whoami)", "'$(whoami)'"},
		{"`id`", "'`id`'"},
		{"a;b", "'a;b'"},
	}
	for _, tt := range tests {
		got := shellQuote(tt.input)
		if got != tt.want {
			t.Errorf("shellQuote(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}
