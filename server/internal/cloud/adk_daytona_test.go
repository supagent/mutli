//go:build integration

package cloud

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
	"github.com/daytonaio/daytona/libs/sdk-go/pkg/options"
	"github.com/daytonaio/daytona/libs/sdk-go/pkg/types"
)

// ─── Spike 11a: Fresh pip install baseline ───────────────────────────────────

func TestADKDaytonaFreshInstall(t *testing.T) {
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

	image := daytona.DebianSlim(nil).
		AptGet([]string{"python3", "python3-pip", "python3-venv"})

	t.Log("Creating sandbox...")
	sandboxStart := time.Now()

	sandbox, err := client.Create(ctx, types.ImageParams{
		SandboxBaseParams: types.SandboxBaseParams{},
		Image:             image,
	}, options.WithTimeout(5*time.Minute))
	if err != nil {
		t.Fatalf("Create sandbox: %v", err)
	}
	t.Cleanup(func() {
		sandbox.Delete(context.Background())
	})

	createTime := time.Since(sandboxStart)
	t.Logf("Sandbox created in %s", createTime)

	// Measure pip install time
	t.Log("Installing google-adk via pip...")
	pipStart := time.Now()

	result, err := sandbox.Process.ExecuteCommand(ctx, "pip install --break-system-packages google-adk 2>&1 | tail -3")
	if err != nil {
		t.Fatalf("pip install failed: %v", err)
	}
	pipTime := time.Since(pipStart)
	t.Logf("pip install completed in %s (exit=%d)", pipTime, result.ExitCode)
	t.Logf("pip output: %s", strings.TrimSpace(result.Result)[:min(len(result.Result), 200)])

	// Verify ADK importable
	verifyResult, err := sandbox.Process.ExecuteCommand(ctx, `python3 -c "import google.adk; print('ADK_OK')"`)
	if err != nil || !strings.Contains(verifyResult.Result, "ADK_OK") {
		t.Fatalf("ADK import failed: %v / %s", err, verifyResult.Result)
	}

	t.Logf("── Results ──")
	t.Logf("  Sandbox create: %s", createTime)
	t.Logf("  pip install:    %s", pipTime)
	t.Logf("  Total:          %s", time.Since(sandboxStart))

	if pipTime > 3*time.Minute {
		t.Errorf("pip install took %s (> 3 min) — pre-baked image required", pipTime)
	}
}

// ─── Spike 11c: Network reachability ─────────────────────────────────────────

func TestADKDaytonaNetwork(t *testing.T) {
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
		AptGet([]string{"python3", "python3-pip", "curl"}).
		PipInstall([]string{"google-genai"})

	sandbox, err := client.Create(ctx, types.ImageParams{
		SandboxBaseParams: types.SandboxBaseParams{},
		Image:             image,
	}, options.WithTimeout(5*time.Minute))
	if err != nil {
		t.Fatalf("Create sandbox: %v", err)
	}
	t.Cleanup(func() {
		sandbox.Delete(context.Background())
	})

	// Test Gemini API
	t.Log("Testing Gemini API reachability...")
	curlCmd := fmt.Sprintf(
		`curl -s -o /dev/null -w "%%{http_code}" "https://generativelanguage.googleapis.com/v1beta/models?key=%s"`,
		geminiKey,
	)
	result, err := sandbox.Process.ExecuteCommand(ctx, curlCmd)
	if err != nil {
		t.Errorf("Gemini curl failed: %v", err)
	} else {
		code := strings.TrimSpace(result.Result)
		if code == "200" {
			t.Log("PASS: Gemini API reachable (200)")
		} else {
			t.Errorf("Gemini API returned %s", code)
		}
	}

	// Test actual genai call
	t.Log("Testing Gemini generate_content from sandbox...")
	pythonCmd := fmt.Sprintf(`python3 -c "
import os; os.environ['GOOGLE_API_KEY']='%s'
from google import genai
c = genai.Client()
r = c.models.generate_content(model='gemini-2.5-flash', contents='Say hi in one word')
print('GEMINI_OK:', r.text[:50])
"`, geminiKey)
	result, err = sandbox.Process.ExecuteCommand(ctx, pythonCmd)
	if err != nil {
		t.Errorf("Gemini call failed: %v", err)
	} else if strings.Contains(result.Result, "GEMINI_OK") {
		t.Logf("PASS: Gemini API call succeeded: %s", strings.TrimSpace(result.Result))
	} else {
		t.Errorf("Unexpected: %s", result.Result)
	}
}

// ─── Spike 11 combined: Full ADK agent in Daytona ────────────────────────────

func TestADKDaytonaFullAgent(t *testing.T) {
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

	// Pre-bake ADK into image
	image := daytona.DebianSlim(nil).
		AptGet([]string{"python3", "python3-pip"}).
		PipInstall([]string{"google-adk"})

	t.Log("Creating sandbox with pre-baked ADK...")
	sandboxStart := time.Now()

	envVars := map[string]string{
		"GOOGLE_API_KEY": geminiKey,
	}

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

	// Upload inline agent script
	agentScript := `
import asyncio, json, os, sys, warnings
warnings.filterwarnings("ignore")
from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

def get_issue(issue_id: str) -> dict:
    return {"id": issue_id, "title": "Test issue", "status": "todo"}

async def main():
    agent = Agent(name="test", model="gemini-2.5-flash", instruction="Read the issue and summarize.", tools=[get_issue])
    svc = InMemorySessionService()
    runner = Runner(agent=agent, app_name="daytona", session_service=svc)
    session = await svc.create_session(app_name="daytona", user_id="test")
    msg = types.Content(role="user", parts=[types.Part.from_text(text="Read issue ISS-300")])
    seq = 0
    text = ""
    async for event in runner.run_async(user_id="test", session_id=session.id, new_message=msg):
        if event.content and event.content.parts:
            for part in event.content.parts:
                if part.function_call:
                    seq += 1
                    print(json.dumps({"type":"tool_use","seq":seq,"tool":part.function_call.name}))
                elif part.text:
                    seq += 1
                    text += part.text
                    print(json.dumps({"type":"text","seq":seq,"content":part.text[:200]}))
    print(json.dumps({"type":"result","status":"completed","output":text[:200]}))

asyncio.run(main())
`
	if err := sandbox.FileSystem.UploadFile(ctx, []byte(agentScript), "/workspace/agent.py"); err != nil {
		t.Fatalf("upload agent script: %v", err)
	}

	// Run the agent
	t.Log("Running ADK agent...")
	execStart := time.Now()

	result, err := sandbox.Process.ExecuteCommand(ctx, "cd /workspace && python3 agent.py")
	if err != nil {
		t.Fatalf("agent failed: %v", err)
	}

	execTime := time.Since(execStart)
	totalTime := time.Since(sandboxStart)

	t.Logf("Agent completed in %s (total: %s, exit=%d)", execTime, totalTime, result.ExitCode)

	// Parse NDJSON
	scanner := bufio.NewScanner(strings.NewReader(result.Result))
	var events []map[string]any
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || !strings.HasPrefix(line, "{") {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			continue
		}
		events = append(events, event)
		t.Logf("  EVENT: type=%v tool=%v", event["type"], event["tool"])
	}

	t.Logf("── Results ──")
	t.Logf("  Sandbox create:  %s", createTime)
	t.Logf("  Agent execution: %s", execTime)
	t.Logf("  Total:           %s", totalTime)
	t.Logf("  NDJSON events:   %d", len(events))

	if len(events) == 0 {
		t.Fatal("No NDJSON events received")
	}

	hasResult := false
	for _, e := range events {
		if e["type"] == "result" {
			hasResult = true
			if e["status"] != "completed" {
				t.Errorf("Expected completed, got %v", e["status"])
			}
		}
	}
	if !hasResult {
		t.Error("No result event")
	}

	if totalTime > 90*time.Second {
		t.Logf("WARN: Total time %s exceeds 90s target", totalTime)
	}
}
