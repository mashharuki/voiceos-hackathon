#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# .env が存在する場合は読み込む
if [ -f "$SCRIPT_DIR/.env" ]; then
  export $(grep -v '^#' "$SCRIPT_DIR/.env" | xargs)
fi

exec npx tsx "$SCRIPT_DIR/packages/mcp-server/src/index.ts"
