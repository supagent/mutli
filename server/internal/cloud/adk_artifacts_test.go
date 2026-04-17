//go:build integration

package cloud

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/daytonaio/daytona/libs/sdk-go/pkg/daytona"
	"github.com/daytonaio/daytona/libs/sdk-go/pkg/options"
	"github.com/daytonaio/daytona/libs/sdk-go/pkg/types"
)

// TestADKDaytonaArtifacts validates that an ADK agent can generate
// documents (docx, xlsx) inside a Daytona sandbox and that we can
// extract them via the filesystem API.
func TestADKDaytonaArtifacts(t *testing.T) {
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

	// Pre-bake ADK + document libraries
	image := daytona.DebianSlim(nil).
		AptGet([]string{"python3", "python3-pip"}).
		PipInstall([]string{"google-adk", "python-docx", "openpyxl"})

	t.Log("Creating sandbox with ADK + doc libraries...")
	sandboxStart := time.Now()

	sandbox, err := client.Create(ctx, types.ImageParams{
		SandboxBaseParams: types.SandboxBaseParams{
			EnvVars: map[string]string{"GOOGLE_API_KEY": geminiKey},
		},
		Image: image,
	}, options.WithTimeout(8*time.Minute))
	if err != nil {
		t.Fatalf("Create sandbox: %v", err)
	}
	t.Cleanup(func() { sandbox.Delete(context.Background()) })

	createTime := time.Since(sandboxStart)
	t.Logf("Sandbox created in %s", createTime)

	// Agent script: ADK agent with tools that create documents
	agentScript := `
import asyncio, json, os, sys, warnings
warnings.filterwarnings("ignore")
from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

OUTPUT_DIR = "/workspace/output"
os.makedirs(OUTPUT_DIR, exist_ok=True)

def create_docx(filename: str, title: str, content: str) -> dict:
    """Create a Word document with the given title and content."""
    from docx import Document
    doc = Document()
    doc.add_heading(title, 0)
    doc.add_paragraph(content)
    path = os.path.join(OUTPUT_DIR, filename)
    doc.save(path)
    size = os.path.getsize(path)
    return {"filename": filename, "path": path, "size_bytes": size, "status": "created"}

def create_xlsx(filename: str, headers: list[str], rows: list[list[str]]) -> dict:
    """Create an Excel spreadsheet with headers and data rows."""
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.append(headers)
    for row in rows:
        ws.append(row)
    path = os.path.join(OUTPUT_DIR, filename)
    wb.save(path)
    size = os.path.getsize(path)
    return {"filename": filename, "path": path, "size_bytes": size, "rows": len(rows), "status": "created"}

async def main():
    agent = Agent(
        name="doc_agent",
        model="gemini-2.5-flash",
        instruction=(
            "You create documents. When asked, use create_docx for Word docs "
            "and create_xlsx for spreadsheets. Always include real content."
        ),
        tools=[create_docx, create_xlsx],
    )
    svc = InMemorySessionService()
    runner = Runner(agent=agent, app_name="artifacts", session_service=svc)
    session = await svc.create_session(app_name="artifacts", user_id="test")

    prompt = (
        "Create two files: "
        "1) A Word doc called 'report.docx' with title 'Q3 Analysis' and a paragraph about project management trends. "
        "2) An Excel file called 'comparison.xlsx' comparing Linear, Jira, and Asana with columns: Tool, Price, Rating."
    )
    msg = types.Content(role="user", parts=[types.Part.from_text(text=prompt)])

    seq = 0
    text = ""
    async for event in runner.run_async(user_id="test", session_id=session.id, new_message=msg):
        if event.content and event.content.parts:
            for part in event.content.parts:
                if part.function_call:
                    seq += 1
                    print(json.dumps({"type":"tool_use","seq":seq,"tool":part.function_call.name}))
                elif part.function_response:
                    seq += 1
                    resp = dict(part.function_response.response) if part.function_response.response else {}
                    print(json.dumps({"type":"tool_result","seq":seq,"tool":part.function_response.name,"output":json.dumps(resp)}))
                elif part.text:
                    seq += 1
                    text += part.text
                    print(json.dumps({"type":"text","seq":seq,"content":part.text[:200]}))

    # List created files
    files = os.listdir(OUTPUT_DIR) if os.path.exists(OUTPUT_DIR) else []
    print(json.dumps({"type":"result","status":"completed","output":text[:200],"artifacts":files}))

asyncio.run(main())
`

	if err := sandbox.FileSystem.UploadFile(ctx, []byte(agentScript), "/workspace/agent.py"); err != nil {
		t.Fatalf("upload: %v", err)
	}

	// Run agent
	t.Log("Running document generation agent...")
	execStart := time.Now()

	result, err := sandbox.Process.ExecuteCommand(ctx, "cd /workspace && python3 agent.py")
	if err != nil {
		t.Fatalf("agent failed: %v\noutput: %s", err, result.Result)
	}

	execTime := time.Since(execStart)
	t.Logf("Agent completed in %s (exit=%d)", execTime, result.ExitCode)
	t.Logf("Output:\n%s", result.Result)

	// Check files exist in sandbox
	lsResult, err := sandbox.Process.ExecuteCommand(ctx, "ls -la /workspace/output/")
	if err != nil {
		t.Fatalf("ls failed: %v", err)
	}
	t.Logf("Files in /workspace/output/:\n%s", lsResult.Result)

	// Extract artifacts
	t.Log("Extracting artifacts...")

	for _, filename := range []string{"report.docx", "comparison.xlsx"} {
		path := "/workspace/output/" + filename
		data, err := sandbox.FileSystem.DownloadFile(ctx, path, nil)
		if err != nil {
			t.Errorf("FAIL: Could not download %s: %v", filename, err)
			continue
		}
		t.Logf("PASS: Extracted %s (%d bytes)", filename, len(data))

		// Basic validation
		if filename == "report.docx" && len(data) > 0 {
			// DOCX is a ZIP file — first bytes should be PK
			if data[0] == 'P' && data[1] == 'K' {
				t.Logf("PASS: %s is a valid ZIP/DOCX file", filename)
			} else {
				t.Errorf("FAIL: %s doesn't start with PK magic bytes", filename)
			}
		}
		if filename == "comparison.xlsx" && len(data) > 0 {
			if data[0] == 'P' && data[1] == 'K' {
				t.Logf("PASS: %s is a valid ZIP/XLSX file", filename)
			} else {
				t.Errorf("FAIL: %s doesn't start with PK magic bytes", filename)
			}
		}
	}

	totalTime := time.Since(sandboxStart)
	t.Logf("── Results ──")
	t.Logf("  Sandbox create: %s", createTime)
	t.Logf("  Agent exec:     %s", execTime)
	t.Logf("  Total:          %s", totalTime)

	if !strings.Contains(lsResult.Result, "report.docx") {
		t.Error("FAIL: report.docx not found")
	}
	if !strings.Contains(lsResult.Result, "comparison.xlsx") {
		t.Error("FAIL: comparison.xlsx not found")
	}
}
