#!/usr/bin/env bash
# Start the demo: builds the UI once, then serves UI + engine on http://localhost:8000
set -euo pipefail
cd "$(dirname "$0")"
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -f "$HOME/.secrets.personal" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.secrets.personal"
  export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY_PERSONAL:-}"
fi
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Set ANTHROPIC_API_KEY first (the demo makes real LLM calls)." >&2
  exit 1
fi
if [ ! -f frontend/dist/index.html ]; then
  (cd frontend && npm ci && npm run build)
fi
cd backend
uv sync -q
echo "Open http://localhost:${PORT:-8000}"
exec uv run uvicorn dme.server.app:app --port "${PORT:-8000}"
