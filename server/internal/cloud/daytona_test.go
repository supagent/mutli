//go:build integration

package cloud

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/daytonaio/daytona/libs/sdk-go/pkg/daytona"
	"github.com/daytonaio/daytona/libs/sdk-go/pkg/types"
)

func TestDaytonaSandboxRoundtrip(t *testing.T) {
	apiKey := os.Getenv("DAYTONA_API_KEY")
	if apiKey == "" {
		t.Skip("DAYTONA_API_KEY not set; skipping integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	// 1. Initialize client
	client, err := daytona.NewClientWithConfig(&types.DaytonaConfig{
		APIKey: apiKey,
	})
	if err != nil {
		t.Fatalf("NewClientWithConfig: %v", err)
	}
	defer client.Close(ctx)

	// 2. Create sandbox from a stock image
	t.Log("Creating sandbox from ubuntu:22.04...")
	sandbox, err := client.Create(ctx, types.ImageParams{
		Image: "ubuntu:22.04",
	})
	if err != nil {
		t.Fatalf("Create sandbox: %v", err)
	}
	t.Logf("Sandbox created: id=%s", sandbox.ID)

	// Ensure teardown even on failure
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cleanupCancel()
		t.Log("Deleting sandbox...")
		if err := sandbox.Delete(cleanupCtx); err != nil {
			t.Logf("WARNING: failed to delete sandbox %s: %v", sandbox.ID, err)
		} else {
			t.Log("Sandbox deleted")
		}
	})

	// 3. Execute `echo hello` in the sandbox
	result, err := sandbox.Process.ExecuteCommand(ctx, "echo hello")
	if err != nil {
		t.Fatalf("ExecuteCommand: %v", err)
	}

	// 4. Assert stdout contains "hello"
	if result.ExitCode != 0 {
		t.Errorf("expected exit code 0, got %d", result.ExitCode)
	}
	if !strings.Contains(result.Result, "hello") {
		t.Errorf("expected output to contain %q, got %q", "hello", result.Result)
	}

	t.Logf("Command output: %q (exit code %d)", result.Result, result.ExitCode)
}

func TestDaytonaStopStartPreservesState(t *testing.T) {
	apiKey := os.Getenv("DAYTONA_API_KEY")
	if apiKey == "" {
		t.Skip("DAYTONA_API_KEY not set; skipping integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	client, err := daytona.NewClientWithConfig(&types.DaytonaConfig{
		APIKey: apiKey,
	})
	if err != nil {
		t.Fatalf("NewClientWithConfig: %v", err)
	}
	defer client.Close(ctx)

	// 1. Create sandbox
	t.Log("Creating sandbox from ubuntu:22.04...")
	sandbox, err := client.Create(ctx, types.ImageParams{
		Image: "ubuntu:22.04",
	})
	if err != nil {
		t.Fatalf("Create sandbox: %v", err)
	}
	t.Logf("Sandbox created: id=%s", sandbox.ID)

	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cleanupCancel()
		t.Log("Deleting sandbox...")
		if err := sandbox.Delete(cleanupCtx); err != nil {
			t.Logf("WARNING: failed to delete sandbox %s: %v", sandbox.ID, err)
		} else {
			t.Log("Sandbox deleted")
		}
	})

	// 2. Write a file inside the sandbox
	t.Log("Writing /workspace/state.txt...")
	writeResult, err := sandbox.Process.ExecuteCommand(ctx, `echo "persist-test" > /workspace/state.txt`)
	if err != nil {
		t.Fatalf("ExecuteCommand (write): %v", err)
	}
	if writeResult.ExitCode != 0 {
		t.Fatalf("write command failed: exit=%d output=%q", writeResult.ExitCode, writeResult.Result)
	}

	// Verify the file exists before stop
	verifyResult, err := sandbox.Process.ExecuteCommand(ctx, "cat /workspace/state.txt")
	if err != nil {
		t.Fatalf("ExecuteCommand (verify before stop): %v", err)
	}
	t.Logf("Before stop: cat /workspace/state.txt => %q", strings.TrimSpace(verifyResult.Result))

	// 3. Stop the sandbox
	t.Log("Stopping sandbox...")
	stopStart := time.Now()
	if err := sandbox.Stop(ctx); err != nil {
		t.Fatalf("Stop sandbox: %v", err)
	}
	stopDuration := time.Since(stopStart)
	t.Logf("Sandbox stopped in %v", stopDuration)

	// 4. Start the sandbox
	t.Log("Starting sandbox...")
	startStart := time.Now()
	if err := sandbox.Start(ctx); err != nil {
		t.Fatalf("Start sandbox: %v", err)
	}
	startDuration := time.Since(startStart)
	t.Logf("Sandbox started in %v", startDuration)

	// 5. Read the file back
	t.Log("Reading /workspace/state.txt after restart...")
	readResult, err := sandbox.Process.ExecuteCommand(ctx, "cat /workspace/state.txt")
	if err != nil {
		t.Fatalf("ExecuteCommand (read after restart): %v", err)
	}
	if readResult.ExitCode != 0 {
		t.Fatalf("read command failed: exit=%d output=%q", readResult.ExitCode, readResult.Result)
	}

	// 6. Assert the content survived the stop/start cycle
	got := strings.TrimSpace(readResult.Result)
	t.Logf("After restart: cat /workspace/state.txt => %q", got)

	if got != "persist-test" {
		t.Errorf("filesystem state NOT preserved: expected %q, got %q", "persist-test", got)
	} else {
		t.Log("SUCCESS: filesystem state preserved across stop/start")
	}

	t.Logf("Summary: Stop=%v, Start=%v", stopDuration, startDuration)
}

func TestDaytonaFSDownload(t *testing.T) {
	apiKey := os.Getenv("DAYTONA_API_KEY")
	if apiKey == "" {
		t.Skip("DAYTONA_API_KEY not set; skipping integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	client, err := daytona.NewClientWithConfig(&types.DaytonaConfig{
		APIKey: apiKey,
	})
	if err != nil {
		t.Fatalf("NewClientWithConfig: %v", err)
	}
	defer client.Close(ctx)

	// 1. Create sandbox
	t.Log("Creating sandbox from ubuntu:22.04...")
	sandbox, err := client.Create(ctx, types.ImageParams{
		Image: "ubuntu:22.04",
	})
	if err != nil {
		t.Fatalf("Create sandbox: %v", err)
	}
	t.Logf("Sandbox created: id=%s", sandbox.ID)

	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cleanupCancel()
		t.Log("Deleting sandbox...")
		if err := sandbox.Delete(cleanupCtx); err != nil {
			t.Logf("WARNING: failed to delete sandbox %s: %v", sandbox.ID, err)
		} else {
			t.Log("Sandbox deleted")
		}
	})

	// 2. Write 3 test files via ExecuteCommand
	testFiles := map[string]string{
		"/workspace/output/report.md":  "# Test Report\n\nThis is a test report with **markdown** content.\n",
		"/workspace/output/data.csv":   "name,age,city\nAlice,30,NYC\nBob,25,SF\nCharlie,35,LA\n",
		"/workspace/output/config.json": `{"version": 1, "debug": true, "name": "test-config"}` + "\n",
	}

	t.Log("Creating /workspace/output/ directory and writing test files...")
	mkdirResult, err := sandbox.Process.ExecuteCommand(ctx, "mkdir -p /workspace/output")
	if err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if mkdirResult.ExitCode != 0 {
		t.Fatalf("mkdir failed: exit=%d output=%q", mkdirResult.ExitCode, mkdirResult.Result)
	}

	for path, content := range testFiles {
		// Use UploadFile to write exact content (avoids shell escaping issues)
		err := sandbox.FileSystem.UploadFile(ctx, []byte(content), path)
		if err != nil {
			t.Fatalf("UploadFile %s: %v", path, err)
		}
		t.Logf("Uploaded %s (%d bytes)", path, len(content))
	}

	// 3. List files via FileSystem API
	t.Log("Listing /workspace/output/ via FileSystem.ListFiles...")
	files, err := sandbox.FileSystem.ListFiles(ctx, "/workspace/output/")
	if err != nil {
		t.Fatalf("ListFiles: %v", err)
	}

	t.Logf("ListFiles returned %d entries:", len(files))
	foundFiles := make(map[string]bool)
	for _, f := range files {
		t.Logf("  %s (dir=%v, size=%d, mode=%s)", f.Name, f.IsDirectory, f.Size, f.Mode)
		foundFiles[f.Name] = true
	}

	// Assert we found all 3 files
	expectedNames := []string{"report.md", "data.csv", "config.json"}
	for _, name := range expectedNames {
		if !foundFiles[name] {
			t.Errorf("ListFiles: expected to find %q, but it was missing", name)
		}
	}

	// 4. Download each file via FileSystem API and verify content
	t.Log("Downloading files via FileSystem.DownloadFile...")
	for path, expectedContent := range testFiles {
		data, err := sandbox.FileSystem.DownloadFile(ctx, path, nil)
		if err != nil {
			t.Fatalf("DownloadFile(%s): %v", path, err)
		}
		got := string(data)
		t.Logf("Downloaded %s: %d bytes", path, len(data))

		if got != expectedContent {
			t.Errorf("DownloadFile(%s): content mismatch\n  expected: %q\n  got:      %q", path, expectedContent, got)
		} else {
			t.Logf("  Content matches for %s", path)
		}
	}

	t.Log("SUCCESS: FileSystem ListFiles + DownloadFile round-trip verified")
}

func hasExactLine(out, want string) bool {
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == want {
			return true
		}
	}
	return false
}

func TestDaytonaPtyStreamingIncremental(t *testing.T) {
	apiKey := os.Getenv("DAYTONA_API_KEY")
	if apiKey == "" {
		t.Skip("DAYTONA_API_KEY not set; skipping integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	client, err := daytona.NewClientWithConfig(&types.DaytonaConfig{
		APIKey: apiKey,
	})
	if err != nil {
		t.Fatalf("NewClientWithConfig: %v", err)
	}
	defer client.Close(ctx)

	t.Log("Creating sandbox...")
	sandbox, err := client.Create(ctx, types.ImageParams{
		Image: "ubuntu:22.04",
	})
	if err != nil {
		t.Fatalf("Create sandbox: %v", err)
	}
	t.Logf("Sandbox created: id=%s", sandbox.ID)

	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cleanupCancel()
		t.Log("Deleting sandbox...")
		if err := sandbox.Delete(cleanupCtx); err != nil {
			t.Logf("WARNING: failed to delete sandbox %s: %v", sandbox.ID, err)
		} else {
			t.Log("Sandbox deleted")
		}
	})

	// Create a PTY session for streaming
	sessionID := fmt.Sprintf("test-stream-%d", time.Now().UnixMilli())
	handle, err := sandbox.Process.CreatePty(ctx, sessionID)
	if err != nil {
		t.Fatalf("CreatePty: %v", err)
	}
	t.Cleanup(func() {
		if err := handle.Disconnect(); err != nil {
			t.Logf("Disconnect PTY: %v", err)
		}
	})
	if err := handle.WaitForConnection(ctx); err != nil {
		t.Fatalf("WaitForConnection: %v", err)
	}
	t.Log("PTY session connected")

	// Track when each chunk arrives
	type chunk struct {
		data string
		at   time.Time
	}
	chunks := make([]chunk, 0, 10)
	done := make(chan struct{})

	go func() {
		defer close(done)
		for data := range handle.DataChan() {
			chunks = append(chunks, chunk{data: string(data), at: time.Now()})
		}
	}()

	// Send a command that emits 5 lines, one per second
	cmd := "for i in 1 2 3 4 5; do echo \"line $i\"; sleep 1; done\nexit\n"
	t.Logf("Sending command: %s", strings.TrimSpace(cmd))
	sendStart := time.Now()
	_, err = handle.Write([]byte(cmd))
	if err != nil {
		t.Fatalf("Write to PTY: %v", err)
	}

	// Wait for process to finish (5s of sleeps + buffer)
	select {
	case <-done:
		t.Log("PTY channel closed")
	case <-time.After(30 * time.Second):
		t.Fatal("Timed out waiting for PTY output")
	}
	totalDuration := time.Since(sendStart)

	// Log all chunks with timing
	t.Logf("Received %d chunks over %v:", len(chunks), totalDuration)
	for i, c := range chunks {
		elapsed := c.at.Sub(sendStart)
		t.Logf("  chunk[%d] at +%v: %q", i, elapsed.Round(time.Millisecond), c.data)
	}

	// Assert: we got multiple chunks (not everything batched at the end)
	if len(chunks) < 3 {
		t.Errorf("expected >=3 chunks for incremental delivery, got %d", len(chunks))
	}

	// Assert: all 5 lines appeared somewhere in the output
	combined := ""
	for _, c := range chunks {
		combined += c.data
	}
	for i := 1; i <= 5; i++ {
		needle := fmt.Sprintf("line %d", i)
		if !strings.Contains(combined, needle) {
			t.Errorf("missing %q in combined output", needle)
		}
	}

	// Assert: chunks arrived over time, not all at once
	// The first and last chunk should be at least 2s apart (5 lines × 1s sleep)
	if len(chunks) >= 2 {
		spread := chunks[len(chunks)-1].at.Sub(chunks[0].at)
		t.Logf("Time spread between first and last chunk: %v", spread)
		if spread < 2*time.Second {
			t.Errorf("expected chunks spread over >=2s (incremental), got %v (likely buffered)", spread)
		}
	}
}

func TestDaytonaStopDuringActiveProcess(t *testing.T) {
	apiKey := os.Getenv("DAYTONA_API_KEY")
	if apiKey == "" {
		t.Skip("DAYTONA_API_KEY not set; skipping integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	client, err := daytona.NewClientWithConfig(&types.DaytonaConfig{
		APIKey: apiKey,
	})
	if err != nil {
		t.Fatalf("NewClientWithConfig: %v", err)
	}
	defer client.Close(ctx)

	// 1. Create sandbox
	t.Log("Creating sandbox from ubuntu:22.04...")
	sandbox, err := client.Create(ctx, types.ImageParams{
		Image: "ubuntu:22.04",
	})
	if err != nil {
		t.Fatalf("Create sandbox: %v", err)
	}
	t.Logf("Sandbox created: id=%s", sandbox.ID)

	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cleanupCancel()
		t.Log("Deleting sandbox...")
		if err := sandbox.Delete(cleanupCtx); err != nil {
			t.Logf("WARNING: failed to delete sandbox %s: %v", sandbox.ID, err)
		} else {
			t.Log("Sandbox deleted")
		}
	})

	// 2. Create a PTY session
	sessionID := fmt.Sprintf("test-stop-%d", time.Now().UnixMilli())
	handle, err := sandbox.Process.CreatePty(ctx, sessionID)
	if err != nil {
		t.Fatalf("CreatePty: %v", err)
	}
	t.Cleanup(func() {
		if err := handle.Disconnect(); err != nil {
			t.Logf("Disconnect PTY: %v", err)
		}
	})
	if err := handle.WaitForConnection(ctx); err != nil {
		t.Fatalf("WaitForConnection: %v", err)
	}
	t.Log("PTY session connected")

	// 3. Collect output in a goroutine
	type chunk struct {
		data string
		at   time.Time
	}
	var chunksMu sync.Mutex
	chunks := make([]chunk, 0, 10)
	dataChanClosed := make(chan struct{})

	go func() {
		defer close(dataChanClosed)
		for data := range handle.DataChan() {
			chunksMu.Lock()
			chunks = append(chunks, chunk{data: string(data), at: time.Now()})
			chunksMu.Unlock()
		}
	}()

	// 4. Start a long-running process (60 ticks, one per second)
	cmd := `for i in $(seq 1 60); do echo "tick $i"; sleep 1; done` + "\n"
	t.Log("Sending long-running command...")
	_, err = handle.Write([]byte(cmd))
	if err != nil {
		t.Fatalf("Write to PTY: %v", err)
	}

	// 5. Wait until we've observed at least 2 ticks (or 10s timeout)
	t.Log("Waiting for at least 2 ticks...")
	deadline := time.After(10 * time.Second)
waitLoop:
	for {
		select {
		case <-deadline:
			t.Log("Timeout waiting for ticks, proceeding with Stop()")
			break waitLoop
		case <-time.After(200 * time.Millisecond):
			chunksMu.Lock()
			combined := ""
			for _, c := range chunks {
				combined += c.data
			}
			chunksMu.Unlock()
			if hasExactLine(combined, "tick 2") {
				t.Log("Observed tick 2, proceeding with Stop()")
				break waitLoop
			}
		}
	}

	// 6. Stop the sandbox while the process is still running
	t.Log("Stopping sandbox while process is active...")
	stopStart := time.Now()
	stopErr := sandbox.Stop(ctx)
	stopDuration := time.Since(stopStart)
	t.Logf("Stop() returned in %v", stopDuration)

	// Assert: Stop() returned without error
	if stopErr != nil {
		t.Fatalf("Stop() returned error: %v", stopErr)
	}
	t.Log("Stop() returned without error")

	// 7. Assert: PTY DataChan() closes (doesn't hang forever -- 10s timeout)
	select {
	case <-dataChanClosed:
		t.Log("PTY DataChan() closed cleanly")
	case <-time.After(10 * time.Second):
		t.Fatal("PTY DataChan() did not close within 10s after Stop() -- goroutine is hanging")
	}

	// 8. Assert: at least 2 ticks were received before stop
	chunksMu.Lock()
	combined := ""
	for _, c := range chunks {
		combined += c.data
	}
	chunksMu.Unlock()
	t.Logf("Combined PTY output (%d chunks): %q", len(chunks), combined)

	tickCount := 0
	for i := 1; i <= 60; i++ {
		if hasExactLine(combined, fmt.Sprintf("tick %d", i)) {
			tickCount++
		}
	}
	t.Logf("Received %d ticks before stop", tickCount)
	if tickCount < 2 {
		t.Errorf("expected at least 2 ticks before stop, got %d", tickCount)
	}

	// 9. Start the sandbox again to verify it isn't corrupted
	t.Log("Starting sandbox after stop...")
	startStart := time.Now()
	if err := sandbox.Start(ctx); err != nil {
		t.Fatalf("Start() after stop failed: %v", err)
	}
	startDuration := time.Since(startStart)
	t.Logf("Start() returned in %v", startDuration)

	// 10. Run a simple command to verify the sandbox works
	t.Log("Running verification command...")
	result, err := sandbox.Process.ExecuteCommand(ctx, "echo ok")
	if err != nil {
		t.Fatalf("ExecuteCommand after restart: %v", err)
	}
	if result.ExitCode != 0 {
		t.Errorf("expected exit code 0, got %d", result.ExitCode)
	}
	if !strings.Contains(result.Result, "ok") {
		t.Errorf("expected output to contain %q, got %q", "ok", result.Result)
	}
	t.Logf("Verification command output: %q (exit code %d)", result.Result, result.ExitCode)

	t.Logf("Summary: Stop=%v, Start=%v, Ticks received=%d", stopDuration, startDuration, tickCount)
	t.Log("SUCCESS: Stop() during active process worked cleanly")
}
