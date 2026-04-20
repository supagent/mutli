package cloud

import (
	"context"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/agent"
)

// drainLineBuffer simulates the PTY line buffer logic by feeding chunks
// through drainNDJSON and collecting parsed messages.
func drainLineBuffer(chunks []string) ([]agent.Message, *agent.Result) {
	msgCh := make(chan agent.Message, 256)
	dataCh := make(chan []byte, len(chunks))
	for _, c := range chunks {
		dataCh <- []byte(c)
	}
	close(dataCh)

	result := drainNDJSON(context.Background(), dataCh, msgCh)
	close(msgCh)

	var msgs []agent.Message
	for m := range msgCh {
		msgs = append(msgs, m)
	}
	return msgs, result
}

func TestDrainNDJSON_SingleComplete(t *testing.T) {
	msgs, _ := drainLineBuffer([]string{
		`{"type":"text","seq":1,"content":"Hello"}` + "\n",
	})
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].Type != agent.MessageText || msgs[0].Content != "Hello" {
		t.Errorf("unexpected message: %+v", msgs[0])
	}
}

func TestDrainNDJSON_SplitAcrossChunks(t *testing.T) {
	msgs, _ := drainLineBuffer([]string{
		`{"type":"tex`,
		`t","seq":1,"content":"Split"}` + "\n",
	})
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].Content != "Split" {
		t.Errorf("expected content 'Split', got %q", msgs[0].Content)
	}
}

func TestDrainNDJSON_MultipleInOneChunk(t *testing.T) {
	msgs, _ := drainLineBuffer([]string{
		`{"type":"text","seq":1,"content":"A"}` + "\n" + `{"type":"text","seq":2,"content":"B"}` + "\n",
	})
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	if msgs[0].Content != "A" || msgs[1].Content != "B" {
		t.Errorf("unexpected messages: %+v, %+v", msgs[0], msgs[1])
	}
}

func TestDrainNDJSON_ANSIWrapped(t *testing.T) {
	msgs, _ := drainLineBuffer([]string{
		"\x1b[?2004l\r" + `{"type":"text","seq":1,"content":"4"}` + "\r\n",
	})
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].Content != "4" {
		t.Errorf("expected content '4', got %q", msgs[0].Content)
	}
}

func TestDrainNDJSON_NonJSONSkipped(t *testing.T) {
	msgs, _ := drainLineBuffer([]string{
		"root@sandbox:~# \n",
		"python3 agent.py --task-id test\n",
		`{"type":"text","seq":1,"content":"Hi"}` + "\n",
		"exit\n",
	})
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message (non-JSON skipped), got %d", len(msgs))
	}
	if msgs[0].Content != "Hi" {
		t.Errorf("expected content 'Hi', got %q", msgs[0].Content)
	}
}

func TestDrainNDJSON_EmptyChunks(t *testing.T) {
	msgs, _ := drainLineBuffer([]string{
		"",
		"",
		`{"type":"text","seq":1,"content":"Ok"}` + "\n",
		"",
	})
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
}

func TestDrainNDJSON_FlushRemaining(t *testing.T) {
	msgs, _ := drainLineBuffer([]string{
		`{"type":"text","seq":1,"content":"Partial"}`,
	})
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message from flush, got %d", len(msgs))
	}
	if msgs[0].Content != "Partial" {
		t.Errorf("expected content 'Partial', got %q", msgs[0].Content)
	}
}

func TestDrainNDJSON_ContextCancellation(t *testing.T) {
	msgCh := make(chan agent.Message, 256)
	dataCh := make(chan []byte, 10)

	dataCh <- []byte(`{"type":"text","seq":1,"content":"Before"}` + "\n")

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan struct{})
	go func() {
		drainNDJSON(ctx, dataCh, msgCh)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("drainNDJSON hung after context cancellation")
	}
	close(msgCh)

	var msgs []agent.Message
	for m := range msgCh {
		msgs = append(msgs, m)
	}
	t.Logf("got %d messages after context cancel", len(msgs))
}

func TestDrainNDJSON_ToolEvents(t *testing.T) {
	msgs, _ := drainLineBuffer([]string{
		`{"type":"text","seq":1,"content":"Part 1"}` + "\n",
		`{"type":"tool_use","seq":2,"tool":"get_issue","input":{"issue_id":"ISS-1"}}` + "\n",
		`{"type":"tool_result","seq":3,"tool":"get_issue","output":"data"}` + "\n",
		`{"type":"text","seq":4,"content":"Part 2"}` + "\n",
	})
	if len(msgs) != 4 {
		t.Fatalf("expected 4 messages, got %d", len(msgs))
	}
	if msgs[0].Type != agent.MessageText {
		t.Errorf("msg 0 type = %s, want text", msgs[0].Type)
	}
	if msgs[1].Type != agent.MessageToolUse || msgs[1].Tool != "get_issue" {
		t.Errorf("msg 1: %+v", msgs[1])
	}
	if msgs[2].Type != agent.MessageToolResult || msgs[2].Tool != "get_issue" {
		t.Errorf("msg 2: %+v", msgs[2])
	}
}

func TestDrainNDJSON_ResultEvent(t *testing.T) {
	msgs, result := drainLineBuffer([]string{
		`{"type":"text","seq":1,"content":"Hello"}` + "\n",
		`{"type":"result","status":"completed","output":"Hello","usage":{"gemini-2.5-flash":{"input_tokens":100,"output_tokens":50}}}` + "\n",
	})
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message (result not sent to msgCh), got %d", len(msgs))
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.Status != "completed" {
		t.Errorf("result status = %q, want completed", result.Status)
	}
	if result.Output != "Hello" {
		t.Errorf("result output = %q, want Hello", result.Output)
	}
	if result.Usage == nil || result.Usage["gemini-2.5-flash"].InputTokens != 100 {
		t.Errorf("unexpected usage: %+v", result.Usage)
	}
}

func TestDrainNDJSON_DrainAfterCancel(t *testing.T) {
	msgCh := make(chan agent.Message, 256)
	dataCh := make(chan []byte, 10)

	dataCh <- []byte(`{"type":"text","seq":1,"content":"One"}` + "\n")
	dataCh <- []byte(`{"type":"text","seq":2,"content":"Two"}` + "\n")
	dataCh <- []byte(`{"type":"text","seq":3,"content":"Three"}` + "\n")
	close(dataCh)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan struct{})
	go func() {
		drainNDJSON(ctx, dataCh, msgCh)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("drainNDJSON hung after context cancellation")
	}
	close(msgCh)

	var msgs []agent.Message
	for m := range msgCh {
		msgs = append(msgs, m)
	}

	if len(msgs) != 3 {
		t.Fatalf("expected 3 messages from buffer drain, got %d", len(msgs))
	}
	if msgs[0].Content != "One" || msgs[1].Content != "Two" || msgs[2].Content != "Three" {
		t.Errorf("unexpected messages: %+v", msgs)
	}
}

// ---------------------------------------------------------------------------
// detectContentType tests
// ---------------------------------------------------------------------------

func TestDetectContentType(t *testing.T) {
	tests := []struct {
		name     string
		filename string
		data     []byte
		want     string
	}{
		// Extension override map
		{"markdown", "report.md", []byte("# Hello"), "text/markdown"},
		{"csv", "data.csv", []byte("a,b,c"), "text/csv"},
		{"json", "config.json", []byte(`{"key":"value"}`), "application/json"},
		{"svg", "icon.svg", []byte("<svg></svg>"), "image/svg+xml"},

		// Standard mime package
		{"pdf", "doc.pdf", []byte("%PDF-1.4"), "application/pdf"},
		{"txt", "notes.txt", []byte("plain text"), "text/plain; charset=utf-8"},
		{"html", "page.html", []byte("<html></html>"), "text/html; charset=utf-8"},

		// Case insensitivity
		{"uppercase ext", "REPORT.MD", []byte("# Title"), "text/markdown"},
		{"mixed case", "Data.CSV", []byte("x,y"), "text/csv"},

		// Fallback to content sniffing (no extension)
		{"no extension html", "file", []byte("<html><body>hi</body></html>"), "text/html; charset=utf-8"},
		{"no extension binary", "file", []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}, "image/png"},

		// Known extension via mime package (not in our override map)
		// Platform-dependent MIME types removed (chemical/x-xyz not registered on all OS)
		// Truly unknown extension — falls through to content sniffing
		{"unknown ext text", "data.zzz123", []byte("just plain text here"), "text/plain; charset=utf-8"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := detectContentType(tt.filename, tt.data)
			if got != tt.want {
				t.Errorf("detectContentType(%q) = %q, want %q", tt.filename, got, tt.want)
			}
		})
	}
}

func TestExtractArtifacts_Constants(t *testing.T) {
	// Verify constants are sensible
	if maxArtifactSize != 5<<20 {
		t.Errorf("maxArtifactSize = %d, want %d (5MB)", maxArtifactSize, 5<<20)
	}
	if maxTotalArtifacts != 20<<20 {
		t.Errorf("maxTotalArtifacts = %d, want %d (20MB)", maxTotalArtifacts, 20<<20)
	}
	if artifactOutputDir != "/workspace/output/" {
		t.Errorf("artifactOutputDir = %q, want %q", artifactOutputDir, "/workspace/output/")
	}
}


// ---------------------------------------------------------------------------
// sanitizeFilename tests
// ---------------------------------------------------------------------------

func TestSanitizeFilename(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
		ok    bool
	}{
		{"simple", "report.md", "report.md", true},
		{"with spaces", "my report.md", "my report.md", true},
		{"path traversal", "../../etc/passwd", "", false},
		{"path traversal subtle", "foo/../../../etc/shadow", "", false},
		{"absolute path", "/etc/passwd", "", false},
		{"null byte", "file\x00.md", "", false},
		{"control chars", "file\x01\x02.md", "", false},
		{"directory slash", "subdir/file.md", "", false},
		{"backslash", "sub\\file.md", "", false},
		{"dot dot", "..", "", false},
		{"single dot", ".", "", false},
		{"empty", "", "", false},
		{"leading dot", ".hidden", ".hidden", true},
		{"unicode", "报告.md", "报告.md", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := sanitizeFilename(tt.input)
			if ok != tt.ok {
				t.Errorf("sanitizeFilename(%q) ok = %v, want %v", tt.input, ok, tt.ok)
			}
			if got != tt.want {
				t.Errorf("sanitizeFilename(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// isAllowedFileType tests
// ---------------------------------------------------------------------------

func TestIsAllowedFileType(t *testing.T) {
	tests := []struct {
		filename string
		allowed  bool
	}{
		{"report.md", true},
		{"data.csv", true},
		{"config.json", true},
		{"notes.txt", true},
		{"doc.pdf", true},
		{"sheet.xlsx", true},
		{"REPORT.MD", true},   // case insensitive
		{"data.CSV", true},
		{"script.sh", false},
		{"binary.exe", false},
		{"app.bin", false},
		{"image.png", false},
		{"archive.zip", false},
		{"noextension", false},
	}

	for _, tt := range tests {
		t.Run(tt.filename, func(t *testing.T) {
			if got := isAllowedFileType(tt.filename); got != tt.allowed {
				t.Errorf("isAllowedFileType(%q) = %v, want %v", tt.filename, got, tt.allowed)
			}
		})
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
