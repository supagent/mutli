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
	"github.com/daytonaio/daytona/libs/sdk-go/pkg/options"
	"github.com/daytonaio/daytona/libs/sdk-go/pkg/types"
	"github.com/multica-ai/multica/server/pkg/agent"
)

// createTestSandbox creates a minimal sandbox for cancel tests.
// Returns the sandbox and a cleanup function.
func createTestSandbox(t *testing.T, ctx context.Context) *daytona.Sandbox {
	t.Helper()
	apiKey := os.Getenv("DAYTONA_API_KEY")
	if apiKey == "" {
		t.Skip("DAYTONA_API_KEY not set")
	}

	client, err := daytona.NewClientWithConfig(&types.DaytonaConfig{APIKey: apiKey})
	if err != nil {
		t.Fatalf("NewClientWithConfig: %v", err)
	}
	t.Cleanup(func() { client.Close(context.Background()) })

	image := daytona.DebianSlim(nil).
		PipInstall([]string{"openharness-ai==0.1.6"}).
		Env("TERM", "dumb")

	t.Log("Creating sandbox...")
	sandbox, err := client.Create(ctx, types.ImageParams{
		SandboxBaseParams: types.SandboxBaseParams{
			EnvVars: map[string]string{"TERM": "dumb"},
		},
		Image: image,
	}, options.WithTimeout(5*time.Minute))
	if err != nil {
		t.Fatalf("Create sandbox: %v", err)
	}
	t.Logf("Sandbox created: %s", sandbox.ID)

	t.Cleanup(func() {
		cleanupCtx, c := context.WithTimeout(context.Background(), 60*time.Second)
		defer c()
		if err := sandbox.Delete(cleanupCtx); err != nil {
			t.Logf("WARNING: delete sandbox %s: %v", sandbox.ID, err)
		}
	})

	return sandbox
}

// TV1: sandbox.Stop() halts a running process and closes PTY DataChan.
func TestSandboxStop_HaltsProcess(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	sandbox := createTestSandbox(t, ctx)

	// Start a long-running process via PTY
	sessionID := fmt.Sprintf("tv1-%d", time.Now().UnixMilli())
	handle, err := sandbox.Process.CreatePty(ctx, sessionID)
	if err != nil {
		t.Fatalf("CreatePty: %v", err)
	}
	if err := handle.WaitForConnection(ctx); err != nil {
		t.Fatalf("WaitForConnection: %v", err)
	}

	// Run a process that will run for a long time
	_, err = handle.Write([]byte("sleep 300\n"))
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	time.Sleep(1 * time.Second) // let it start

	// Track when DataChan closes
	dataChanClosed := make(chan struct{})
	go func() {
		for range handle.DataChan() {
		}
		close(dataChanClosed)
	}()

	// Stop the sandbox
	t.Log("Calling sandbox.Stop()...")
	stopStart := time.Now()
	stopCtx, stopCancel := context.WithTimeout(ctx, 10*time.Second)
	defer stopCancel()
	if err := sandbox.Stop(stopCtx); err != nil {
		t.Fatalf("sandbox.Stop: %v", err)
	}
	stopDuration := time.Since(stopStart)
	t.Logf("sandbox.Stop() completed in %v", stopDuration)

	// DataChan should close within 5 seconds of Stop
	select {
	case <-dataChanClosed:
		t.Log("DataChan closed after Stop — good")
	case <-time.After(5 * time.Second):
		t.Fatal("DataChan did not close within 5s of sandbox.Stop()")
	}

	handle.Disconnect()

	// Verify the sleep process is gone (sandbox is stopped, Start to check)
	startCtx, startCancel := context.WithTimeout(ctx, 30*time.Second)
	defer startCancel()
	if err := sandbox.Start(startCtx); err != nil {
		t.Fatalf("sandbox.Start after stop: %v", err)
	}

	result, err := sandbox.Process.ExecuteCommand(ctx, "pgrep -f 'sleep 300' || echo 'no-process'")
	if err != nil {
		t.Fatalf("pgrep: %v", err)
	}
	if !strings.Contains(result.Result, "no-process") {
		t.Errorf("sleep process still running after Stop+Start: %s", result.Result)
	}
	t.Logf("Process check after restart: %s", strings.TrimSpace(result.Result))
}

// TV2: Stop() then Delete() in sequence is safe.
func TestSandboxStop_ThenDelete(t *testing.T) {
	apiKey := os.Getenv("DAYTONA_API_KEY")
	if apiKey == "" {
		t.Skip("DAYTONA_API_KEY not set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	client, err := daytona.NewClientWithConfig(&types.DaytonaConfig{APIKey: apiKey})
	if err != nil {
		t.Fatalf("NewClientWithConfig: %v", err)
	}
	defer client.Close(ctx)

	image := daytona.DebianSlim(nil).Env("TERM", "dumb")
	sandbox, err := client.Create(ctx, types.ImageParams{
		SandboxBaseParams: types.SandboxBaseParams{
			EnvVars: map[string]string{"TERM": "dumb"},
		},
		Image: image,
	}, options.WithTimeout(5*time.Minute))
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Logf("Sandbox created: %s", sandbox.ID)

	// Stop then Delete — both should succeed
	stopCtx, stopCancel := context.WithTimeout(ctx, 10*time.Second)
	defer stopCancel()
	if err := sandbox.Stop(stopCtx); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	t.Log("Stop succeeded")

	deleteCtx, deleteCancel := context.WithTimeout(ctx, 30*time.Second)
	defer deleteCancel()
	if err := sandbox.Delete(deleteCtx); err != nil {
		t.Fatalf("Delete after Stop: %v", err)
	}
	t.Log("Delete after Stop succeeded")
}

// TV6: Concurrent sandbox.Stop() + drainPTYData is race-free.
// Run with: go test -race -tags integration -run TestSandboxStop_ConcurrentDrain
func TestSandboxStop_ConcurrentDrain(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	sandbox := createTestSandbox(t, ctx)

	googleKey := os.Getenv("GOOGLE_AI_API_KEY")
	if googleKey == "" {
		t.Skip("GOOGLE_AI_API_KEY required for agent execution")
	}

	// Run a long-running command to simulate agent execution
	sessionID := fmt.Sprintf("tv6-%d", time.Now().UnixMilli())
	handle, err := sandbox.Process.CreatePty(ctx, sessionID)
	if err != nil {
		t.Fatalf("CreatePty: %v", err)
	}
	if err := handle.WaitForConnection(ctx); err != nil {
		t.Fatalf("WaitForConnection: %v", err)
	}

	// Emit NDJSON lines slowly to simulate a running agent
	cmd := `for i in 1 2 3 4 5; do echo "{\"type\":\"text\",\"seq\":$i,\"content\":\"step $i\"}"; sleep 2; done`
	if _, err := handle.Write([]byte(cmd + "\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	// Single-owner goroutine reads DataChan and tees into a local channel.
	// This avoids two goroutines racing on the same channel.
	teeCh := make(chan []byte, 256)
	firstOutput := make(chan struct{})
	go func() {
		defer close(teeCh)
		first := true
		for data := range handle.DataChan() {
			if first {
				close(firstOutput)
				first = false
			}
			teeCh <- data
		}
	}()

	select {
	case <-firstOutput:
		t.Log("First OH output received")
	case <-time.After(60 * time.Second):
		t.Fatal("No OH output after 60s")
	}

	// Now simulate the cancel flow: Stop + drain concurrently
	runCtx, runCancel := context.WithCancel(ctx)
	msgCh := make(chan agent.Message, 256)

	var wg sync.WaitGroup

	// Goroutine 1: drain PTY data via tee channel (simulates the drain goroutine)
	wg.Add(1)
	go func() {
		defer wg.Done()
		drainNDJSON(runCtx, teeCh, msgCh)
		close(msgCh)
	}()

	// Goroutine 2: Stop sandbox (simulates the stop goroutine)
	wg.Add(1)
	go func() {
		defer wg.Done()
		runCancel() // cancel context first
		stopCtx, sc := context.WithTimeout(context.Background(), 5*time.Second)
		defer sc()
		if err := sandbox.Stop(stopCtx); err != nil {
			t.Logf("Stop during drain: %v (may be expected)", err)
		}
	}()

	// Both goroutines must complete without panic or deadlock
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		t.Log("Concurrent stop+drain completed cleanly")
	case <-time.After(30 * time.Second):
		t.Fatal("Concurrent stop+drain hung for 30s")
	}

	// Count recovered messages
	var msgs []agent.Message
	for m := range msgCh {
		msgs = append(msgs, m)
	}
	t.Logf("Recovered %d messages during concurrent cancel", len(msgs))

	handle.Disconnect()
}
