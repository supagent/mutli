#!/bin/bash
# Run all Phase A spikes and report pass/fail.
# Usage: cd server/spike/adk && ./run_phase_a.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Activate venv
if [ -d ".venv" ]; then
    source .venv/bin/activate
fi

# Load API key from project .env if not already set
if [ -z "${GOOGLE_AI_API_KEY:-}" ]; then
    if [ -f "../../../.env" ]; then
        export "$(grep GOOGLE_AI_API_KEY ../../../.env | xargs)"
    fi
fi

if [ -z "${GOOGLE_AI_API_KEY:-}" ]; then
    echo "ERROR: GOOGLE_AI_API_KEY not set"
    exit 1
fi

PASS=0
FAIL=0
RESULTS=()

run_spike() {
    local name="$1"
    local file="$2"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  $name"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if python3 "$file"; then
        PASS=$((PASS + 1))
        RESULTS+=("  ✓ $name")
    else
        FAIL=$((FAIL + 1))
        RESULTS+=("  ✕ $name")
    fi
}

run_spike "Spike 1: Streaming Tool Calls"       spike_01_streaming.py
run_spike "Spike 3: Grounding + Citations"       spike_03_grounding.py
run_spike "Spike 4: Parallel Tool Execution"     spike_04_parallel.py
run_spike "Spike 8: Sub-Agent Delegation"        spike_08_subagents.py

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Phase A Results: $PASS passed, $FAIL failed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
for r in "${RESULTS[@]}"; do
    echo "$r"
done
echo ""

if [ "$FAIL" -gt 0 ]; then
    echo "PHASE A: FAIL"
    exit 1
else
    echo "PHASE A: PASS — proceed with ADK"
    exit 0
fi
