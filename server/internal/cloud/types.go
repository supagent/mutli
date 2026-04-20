package cloud

import "time"

// SandboxConfig holds configuration for the Daytona sandbox manager.
type SandboxConfig struct {
	DaytonaAPIKey   string        // Daytona API authentication
	DaytonaAPIURL   string        // Optional: custom Daytona API URL (SDK default if empty)
	DefaultModel    string        // Default LLM model (default: "gemini-2.5-flash")
	DefaultMaxTurns int           // Default max agent turns (default: 20)
	GeminiAPIKey    string        // Google AI API key for the ADK agent
	MulicaAPIURL    string        // Backend API URL the agent calls from inside sandbox
	AgentToken      string        // Auth token for agent API calls
	ImageTimeout    time.Duration // Timeout for sandbox image build (default: 3min)
}

// TaskExecConfig holds per-task execution parameters.
type TaskExecConfig struct {
	TaskID       string        // Multica task ID (for logging)
	IssueID      string        // Issue ID the agent is working on
	WorkspaceID  string        // Workspace ID for API calls
	Prompt       string        // Agent prompt
	Model        string        // LLM model override (empty = use SandboxConfig.DefaultModel)
	MaxTurns     int           // Max turns override (0 = use SandboxConfig.DefaultMaxTurns)
	SystemPrompt string        // Additional system prompt
	Timeout      time.Duration // Execution timeout (0 = 20min default)
}
