//go:build integration

package cloud

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/daytonaio/daytona/libs/sdk-go/pkg/daytona"
	"github.com/daytonaio/daytona/libs/sdk-go/pkg/options"
	"github.com/daytonaio/daytona/libs/sdk-go/pkg/types"
)

// TestADKDaytonaPrewarm validates the snapshot-based prewarm strategy:
// 1. Create a snapshot with ADK + doc libraries pre-installed
// 2. Create a sandbox FROM the snapshot (should be fast — no pip install)
// 3. Run an agent and measure cold start
func TestADKDaytonaPrewarm(t *testing.T) {
	apiKey := os.Getenv("DAYTONA_API_KEY")
	if apiKey == "" {
		t.Skip("DAYTONA_API_KEY not set")
	}
	geminiKey := os.Getenv("GOOGLE_AI_API_KEY")
	if geminiKey == "" {
		t.Skip("GOOGLE_AI_API_KEY not set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	client, err := daytona.NewClientWithConfig(&types.DaytonaConfig{APIKey: apiKey})
	if err != nil {
		t.Fatalf("NewClientWithConfig: %v", err)
	}
	defer client.Close(ctx)

	snapshotService := daytona.NewSnapshotService(client)

	// ── Step 1: Create snapshot (one-time cost) ──────────────────────────────

	snapshotName := "multica-adk-agent-v1"

	// Check if snapshot already exists
	existing, _ := snapshotService.List(ctx, nil, nil)
	snapshotExists := false
	if existing != nil {
		for _, s := range existing.Items {
			if s.Name == snapshotName {
				snapshotExists = true
				t.Logf("Snapshot '%s' already exists (id=%s, state=%s)", s.Name, s.ID, s.State)
				break
			}
		}
	}

	if !snapshotExists {
		t.Logf("Creating snapshot '%s' (one-time setup)...", snapshotName)
		snapshotStart := time.Now()

		image := daytona.DebianSlim(nil).
			AptGet([]string{"python3", "python3-pip"}).
			PipInstall([]string{"google-adk", "python-docx", "openpyxl"})

		snapshot, logChan, err := snapshotService.Create(ctx, &types.CreateSnapshotParams{
			Name:  snapshotName,
			Image: image,
		})
		if err != nil {
			t.Fatalf("Create snapshot: %v", err)
		}

		// Drain build logs
		if logChan != nil {
			for log := range logChan {
				_ = log // silently consume
			}
		}

		snapshotTime := time.Since(snapshotStart)
		t.Logf("Snapshot created in %s (id=%s)", snapshotTime, snapshot.ID)
	}

	// ── Step 2: Create sandbox FROM snapshot ─────────────────────────────────

	t.Log("Creating sandbox from snapshot (prewarmed)...")
	warmStart := time.Now()

	sandbox, err := client.Create(ctx, types.SnapshotParams{
		SandboxBaseParams: types.SandboxBaseParams{
			EnvVars: map[string]string{"GOOGLE_API_KEY": geminiKey},
		},
		Snapshot: snapshotName,
	}, options.WithTimeout(5*time.Minute))
	if err != nil {
		t.Fatalf("Create from snapshot: %v", err)
	}
	t.Cleanup(func() { sandbox.Delete(context.Background()) })

	warmCreateTime := time.Since(warmStart)
	t.Logf("Prewarmed sandbox created in %s", warmCreateTime)

	// ── Step 3: Verify ADK is available ──────────────────────────────────────

	verifyResult, err := sandbox.Process.ExecuteCommand(ctx, `python3 -c "import google.adk, docx, openpyxl; print('ALL_OK')"`)
	if err != nil || !strings.Contains(verifyResult.Result, "ALL_OK") {
		t.Fatalf("Libraries not available: %v / %s", err, verifyResult.Result)
	}
	t.Log("PASS: ADK + docx + openpyxl all available")

	// ── Step 4: Run agent ────────────────────────────────────────────────────

	agentScript := `
import asyncio, json, os, sys, warnings
warnings.filterwarnings("ignore")
from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

os.makedirs("/workspace/output", exist_ok=True)

def create_docx(filename: str, title: str, content: str) -> dict:
    from docx import Document
    doc = Document()
    doc.add_heading(title, 0)
    doc.add_paragraph(content)
    path = f"/workspace/output/{filename}"
    doc.save(path)
    return {"filename": filename, "size": os.path.getsize(path)}

async def main():
    agent = Agent(name="doc", model="gemini-2.5-flash",
        instruction="Create documents when asked.", tools=[create_docx])
    svc = InMemorySessionService()
    runner = Runner(agent=agent, app_name="prewarm", session_service=svc)
    session = await svc.create_session(app_name="prewarm", user_id="test")
    msg = types.Content(role="user", parts=[types.Part.from_text(
        text="Create a docx called 'test.docx' with title 'Prewarm Test' and content about AI agents.")])
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
    print(json.dumps({"type":"result","status":"completed","artifacts":os.listdir("/workspace/output")}))

asyncio.run(main())
`
	if err := sandbox.FileSystem.UploadFile(ctx, []byte(agentScript), "/workspace/agent.py"); err != nil {
		t.Fatalf("upload: %v", err)
	}

	t.Log("Running agent in prewarmed sandbox...")
	execStart := time.Now()

	result, err := sandbox.Process.ExecuteCommand(ctx, "cd /workspace && python3 agent.py")
	if err != nil {
		t.Fatalf("agent failed: %v\noutput: %s", err, result.Result)
	}

	execTime := time.Since(execStart)
	totalTime := time.Since(warmStart)

	// Parse events
	scanner := bufio.NewScanner(strings.NewReader(result.Result))
	var events []map[string]any
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || !strings.HasPrefix(line, "{") {
			continue
		}
		var event map[string]any
		if json.Unmarshal([]byte(line), &event) == nil {
			events = append(events, event)
		}
	}

	// Extract artifact
	data, err := sandbox.FileSystem.DownloadFile(ctx, "/workspace/output/test.docx", nil)
	if err != nil {
		t.Errorf("FAIL: Could not download test.docx: %v", err)
	} else {
		t.Logf("PASS: Extracted test.docx (%d bytes)", len(data))
	}

	// ── Results ──────────────────────────────────────────────────────────────

	t.Logf("── Results ──")
	t.Logf("  Prewarmed sandbox create: %s", warmCreateTime)
	t.Logf("  Agent execution:          %s", execTime)
	t.Logf("  Total (create + run):     %s", totalTime)
	t.Logf("  NDJSON events:            %d", len(events))
	t.Logf("")
	t.Logf("  Compare: cold start was 56s, prewarmed is %s", warmCreateTime)

	if warmCreateTime < 15*time.Second {
		t.Logf("PASS: Prewarmed sandbox created in < 15s (vs 56s cold)")
	} else if warmCreateTime < 30*time.Second {
		t.Logf("OK: Prewarmed sandbox created in < 30s (vs 56s cold)")
	} else {
		t.Logf("WARN: Prewarmed sandbox took %s — minimal improvement over cold start", warmCreateTime)
	}
}
