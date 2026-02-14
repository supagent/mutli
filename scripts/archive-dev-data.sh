#!/usr/bin/env bash
#
# Archive and clean the dev environment data.
#
# Moves ~/.super-multica-dev and ~/Documents/Multica-dev into a
# timestamped archive directory for later debugging / analysis.
#
# Usage:
#   pnpm dev:local:archive
#
# Archives are stored in: ~/.super-multica-dev-archives/<timestamp>/

set -euo pipefail

TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
ARCHIVE_BASE="$HOME/.super-multica-dev-archives"
ARCHIVE_DIR="$ARCHIVE_BASE/$TIMESTAMP"

DEV_DATA="$HOME/.super-multica-dev"
DEV_WORKSPACE="$HOME/Documents/Multica-dev"

# Check if there's anything to archive
if [ ! -d "$DEV_DATA" ] && [ ! -d "$DEV_WORKSPACE" ]; then
  echo "Nothing to archive — neither $DEV_DATA nor $DEV_WORKSPACE exists."
  exit 0
fi

mkdir -p "$ARCHIVE_DIR"

if [ -d "$DEV_DATA" ]; then
  mv "$DEV_DATA" "$ARCHIVE_DIR/data"
  echo "  Archived $DEV_DATA -> $ARCHIVE_DIR/data"
fi

if [ -d "$DEV_WORKSPACE" ]; then
  mv "$DEV_WORKSPACE" "$ARCHIVE_DIR/workspace"
  echo "  Archived $DEV_WORKSPACE -> $ARCHIVE_DIR/workspace"
fi

echo ""
echo "Archived to: $ARCHIVE_DIR"
echo "Dev environment is now clean. Run 'pnpm dev:local' to start fresh."
