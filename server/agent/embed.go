// Package agentpy embeds the Python files that comprise the ADK agent.
// These are written into the Daytona sandbox at runtime.
package agentpy

import _ "embed"

//go:embed multica_agent.py
var MainPy []byte

//go:embed bridge.py
var BridgePy []byte

//go:embed tools.py
var ToolsPy []byte

//go:embed requirements.txt
var RequirementsTxt []byte
