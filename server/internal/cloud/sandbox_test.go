package cloud

import (
	"testing"

	"github.com/multica-ai/multica/server/pkg/agent"
)

// drainLineBuffer simulates the PTY line buffer logic by feeding chunks
// through drainPTYData and collecting parsed messages.
func drainLineBuffer(chunks []string) []agent.Message {
	msgCh := make(chan agent.Message, 256)
	dataCh := make(chan []byte, len(chunks))
	for _, c := range chunks {
		dataCh <- []byte(c)
	}
	close(dataCh)

	drainPTYData(dataCh, msgCh)
	close(msgCh)

	var msgs []agent.Message
	for m := range msgCh {
		msgs = append(msgs, m)
	}
	return msgs
}

func TestLineBuffer_SingleComplete(t *testing.T) {
	msgs := drainLineBuffer([]string{
		"{\"type\": \"assistant_delta\", \"text\": \"Hello\"}\n",
	})
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].Type != agent.MessageText || msgs[0].Content != "Hello" {
		t.Errorf("unexpected message: %+v", msgs[0])
	}
}

func TestLineBuffer_SplitAcrossChunks(t *testing.T) {
	msgs := drainLineBuffer([]string{
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
	msgs := drainLineBuffer([]string{
		"{\"type\": \"assistant_delta\", \"text\": \"A\"}\n{\"type\": \"assistant_delta\", \"text\": \"B\"}\n",
	})
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	if msgs[0].Content != "A" || msgs[1].Content != "B" {
		t.Errorf("unexpected messages: %+v, %+v", msgs[0], msgs[1])
	}
}

func TestLineBuffer_ANSIWrapped(t *testing.T) {
	msgs := drainLineBuffer([]string{
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
	msgs := drainLineBuffer([]string{
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
	msgs := drainLineBuffer([]string{
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
	// Last line has no trailing newline — should still be parsed
	msgs := drainLineBuffer([]string{
		"{\"type\": \"assistant_delta\", \"text\": \"Partial\"}",
	})
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message from flush, got %d", len(msgs))
	}
	if msgs[0].Content != "Partial" {
		t.Errorf("expected content 'Partial', got %q", msgs[0].Content)
	}
}
