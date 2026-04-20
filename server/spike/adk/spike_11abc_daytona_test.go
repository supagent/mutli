//go:build integration

package adk_test

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/daytonaio/daytona/libs/sdk-go/pkg/daytona"
	"github.com/daytonaio/daytona/libs/sdk-go/pkg/types"
	"github.com/daytonaio/daytona/libs/sdk-go/pkg/options"
)

// ─── Spike 11a: Fresh pip install baseline ───────────────────────────────────

func TestDaytonaFreshInstall(t *testing.T) {
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

	// Use debian slim with Python pre-installed
	image := daytona.DebianSlim(nil).
		AptGet([]string{"python3", "python3-pip", "python3-venv"})

	t.Log("Creating sandbox...")
	sandboxStart := time.Now()

	sandbox, err := client.Create(ctx, types.ImageParams{Image: image},
		options.WithTimeout(8*time.Minute))
	if err != nil {
		t.Fatalf("Create sandbox: %v", err)
	}
	t.Cleanup(func() {
		sandbox.Delete(context.Background())
	})

	createTime := time.Since(sandboxStart)
	t.Logf("Sandbox created in %s", createTime)

	// Measure pip install time
	t.Log("Installing google-adk...")
	pipStart := time.Now()

	result, err := sandbox.Process.ExecuteCommand(ctx, "pip install --break-system-packages google-adk 2>&1 | tail -3")
	if err != nil {
		t.Fatalf("pip install failed: %v", err)
	}
	pipTime := time.Since(pipStart)
	t.Logf("pip install completed in %s", pipTime)
	t.Logf("pip output: %s", result.Result)

	// Verify ADK is importable
	verifyResult, err := sandbox.Process.ExecuteCommand(ctx, `python3 -c "import google.adk; print('ADK OK')"`)
	if err != nil {
		t.Fatalf("ADK import failed: %v", err)
	}
	if !strings.Contains(verifyResult.Result, "ADK OK") {
		t.Fatalf("ADK import verification failed: %s", verifyResult.Result)
	}

	totalTime := time.Since(sandboxStart)
	t.Logf("── Results ──")
	t.Logf("  Sandbox create: %s", createTime)
	t.Logf("  pip install:    %s", pipTime)
	t.Logf("  Total:          %s", totalTime)

	if pipTime > 3*time.Minute {
		t.Errorf("FAIL: pip install took %s (> 3 minutes) — pre-baked image required", pipTime)
	} else {
		t.Logf("PASS: pip install completed in %s", pipTime)
	}
}

// ─── Spike 11c: Network reachability ─────────────────────────────────────────

func TestDaytonaNetworkReachability(t *testing.T) {
	apiKey := os.Getenv("DAYTONA_API_KEY")
	if apiKey == "" {
		t.Skip("DAYTONA_API_KEY not set")
	}
	geminiKey := os.Getenv("GOOGLE_AI_API_KEY")
	if geminiKey == "" {
		t.Skip("GOOGLE_AI_API_KEY not set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	client, err := daytona.NewClientWithConfig(&types.DaytonaConfig{APIKey: apiKey})
	if err != nil {
		t.Fatalf("NewClientWithConfig: %v", err)
	}
	defer client.Close(ctx)

	image := daytona.DebianSlim(nil).
		AptGet([]string{"python3", "python3-pip", "python3-venv", "curl"}).
		Run("pip install --break-system-packages google-genai")

	envVars := map[string]string{"GOOGLE_API_KEY": geminiKey}

	sandbox, err := client.Create(ctx, types.ImageParams{
		SandboxBaseParams: types.SandboxBaseParams{EnvVars: envVars},
		Image:             image,
	}, options.WithTimeout(8*time.Minute))
	if err != nil {
		t.Fatalf("Create sandbox: %v", err)
	}
	t.Cleanup(func() {
		sandbox.Delete(context.Background())
	})

	// Test 1: Gemini API reachability
	t.Log("Testing Gemini API reachability...")
	geminiTest := fmt.Sprintf(
		`curl -s -o /dev/null -w "%%{http_code}" "https://generativelanguage.googleapis.com/v1beta/models?key=%s"`,
		geminiKey,
	)
	result, err := sandbox.Process.ExecuteCommand(ctx, geminiTest)
	if err != nil {
		t.Errorf("Gemini API test failed: %v", err)
	} else {
		httpCode := strings.TrimSpace(result.Result)
		if httpCode == "200" {
			t.Log("PASS: Gemini API reachable (200)")
		} else {
			t.Errorf("FAIL: Gemini API returned %s (expected 200)", httpCode)
		}
	}

	// Test 2: Google Search (for grounding)
	t.Log("Testing Google Search reachability...")
	searchTest := `curl -s -o /dev/null -w "%{http_code}" "https://www.google.com/search?q=test" -H "User-Agent: Mozilla/5.0"`
	result, err = sandbox.Process.ExecuteCommand(ctx, searchTest)
	if err != nil {
		t.Logf("WARN: Google Search test failed: %v (grounding may use a different endpoint)", err)
	} else {
		t.Logf("Google Search returned: %s", strings.TrimSpace(result.Result))
	}

	// Test 3: Actual Gemini API call with google-genai
	t.Log("Testing actual Gemini API call from sandbox...")
	pythonTest := `python3 -c "
from google import genai
client = genai.Client()
resp = client.models.generate_content(model='gemini-2.5-flash', contents='Say hello in one word')
print('GEMINI_OK:', resp.text[:50])
"`

	result, err = sandbox.Process.ExecuteCommand(ctx, pythonTest)
	if err != nil {
		t.Errorf("FAIL: Gemini API call from sandbox failed: %v", err)
	} else if strings.Contains(result.Result, "GEMINI_OK") {
		t.Logf("PASS: Gemini API call succeeded: %s", strings.TrimSpace(result.Result))
	} else {
		t.Errorf("FAIL: Unexpected output: %s", result.Result)
	}
}

// ─── Spike 11 combined: Full ADK agent in Daytona ────────────────────────────

func TestDaytonaADKAgent(t *testing.T) {
	apiKey := os.Getenv("DAYTONA_API_KEY")
	if apiKey == "" {
		t.Skip("DAYTONA_API_KEY not set")
	}
	geminiKey := os.Getenv("GOOGLE_AI_API_KEY")
	if geminiKey == "" {
		t.Skip("GOOGLE_AI_API_KEY not set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	client, err := daytona.NewClientWithConfig(&types.DaytonaConfig{APIKey: apiKey})
	if err != nil {
		t.Fatalf("NewClientWithConfig: %v", err)
	}
	defer client.Close(ctx)

	// Pre-bake ADK into the image
	image := daytona.DebianSlim(nil).
		AptGet([]string{"python3", "python3-pip", "python3-venv"}).
		Run("pip install --break-system-packages google-adk")

	envVars := map[string]string{"GOOGLE_API_KEY": geminiKey}

	t.Log("Creating sandbox with pre-baked ADK image...")
	sandboxStart := time.Now()

	sandbox, err := client.Create(ctx, types.ImageParams{
		SandboxBaseParams: types.SandboxBaseParams{EnvVars: envVars},
		Image:             image,
	}, options.WithTimeout(8*time.Minute))
	if err != nil {
		t.Fatalf("Create sandbox: %v", err)
	}
	t.Cleanup(func() {
		sandbox.Delete(context.Background())
	})

	createTime := time.Since(sandboxStart)
	t.Logf("Sandbox created in %s", createTime)

	// Upload the subprocess agent script
	agentScript, err := os.ReadFile("spike_11e_subprocess.py")
	if err != nil {
		t.Fatalf("read agent script: %v", err)
	}

	if err := sandbox.FileSystem.UploadFile(ctx, agentScript, "/workspace/agent.py"); err != nil {
		t.Fatalf("upload agent script: %v", err)
	}

	// Run the agent
	t.Log("Running ADK agent in sandbox...")
	execStart := time.Now()

	execResult, err := sandbox.Process.ExecuteCommand(ctx,
		`cd /workspace && python3 agent.py --task-id "daytona-test" --issue-id "ISS-300" --prompt "Read issue ISS-300 and summarize it."`)
	if err != nil {
		t.Fatalf("agent execution failed: %v\noutput: %s", err, execResult.Result)
	}

	execTime := time.Since(execStart)
	totalTime := time.Since(sandboxStart)

	t.Logf("Agent completed in %s (total with sandbox: %s)", execTime, totalTime)

	// Parse NDJSON output
	scanner := bufio.NewScanner(strings.NewReader(execResult.Result))
	var events []map[string]any
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || !strings.HasPrefix(line, "{") {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Logf("WARN: non-JSON line: %s", line)
			continue
		}
		events = append(events, event)
		t.Logf("  EVENT: type=%s tool=%v", event["type"], event["tool"])
	}

	// Validate
	t.Logf("── Results ──")
	t.Logf("  Sandbox create: %s", createTime)
	t.Logf("  Agent exec:     %s", execTime)
	t.Logf("  Total:          %s", totalTime)
	t.Logf("  NDJSON events:  %d", len(events))

	if len(events) == 0 {
		t.Fatal("FAIL: No NDJSON events received from sandbox")
	}

	// Check for result event
	hasResult := false
	for _, e := range events {
		if e["type"] == "result" {
			hasResult = true
			t.Logf("  Result status: %v", e["status"])
			if e["status"] != "completed" {
				t.Errorf("FAIL: Expected status 'completed', got %v", e["status"])
			}
		}
	}
	if !hasResult {
		t.Error("FAIL: No result event in output")
	}

	// Check timing
	if totalTime > 90*time.Second {
		t.Errorf("WARN: Total time %s exceeds 90s target", totalTime)
	}
}
