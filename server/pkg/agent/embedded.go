package agent

import (
	"context"
	"fmt"
	"time"
)

// EmbeddedBackend implements Backend by running an ADK agent inside a Daytona sandbox.
// It delegates execution to a SandboxExecutor (the cloud.SandboxManager).
type EmbeddedBackend struct {
	Executor SandboxExecutor
}

// SandboxExecutor abstracts sandbox execution so the agent package
// doesn't import cloud/ directly (avoiding circular dependencies).
type SandboxExecutor interface {
	Execute(ctx context.Context, cfg SandboxTaskConfig) (*Session, error)
}

// SubAgentDef defines a sub-agent for multi-agent orchestration.
// Serialized to JSON and uploaded to the sandbox for ADK construction.
type SubAgentDef struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	Instructions string `json:"instructions"`
}

// SandboxTaskConfig is the task config passed to the sandbox executor.
type SandboxTaskConfig struct {
	TaskID       string
	IssueID      string
	WorkspaceID  string
	Prompt       string
	Model        string
	MaxTurns     int
	SystemPrompt string
	Timeout      time.Duration
	SubAgents    []SubAgentDef
	Role         string
	ToolsMode    string // "search" for google_search only, empty for default
}

func (b *EmbeddedBackend) Execute(ctx context.Context, prompt string, opts ExecOptions) (*Session, error) {
	if opts.ResumeSessionID != "" {
		return nil, fmt.Errorf("embedded backend does not support session resume")
	}
	if b.Executor == nil {
		return nil, fmt.Errorf("embedded runtime not configured (missing DAYTONA_API_KEY)")
	}

	return b.Executor.Execute(ctx, SandboxTaskConfig{
		TaskID:       opts.TaskID,
		IssueID:      opts.IssueID,
		WorkspaceID:  opts.WorkspaceID,
		Prompt:       prompt,
		Model:        opts.Model,
		MaxTurns:     opts.MaxTurns,
		SystemPrompt: opts.SystemPrompt,
		Timeout:      opts.Timeout,
		SubAgents:    opts.SubAgents,
		Role:         opts.Role,
		ToolsMode:    opts.ToolsMode,
	})
}
