#!/usr/bin/env bash
# Start the demo: builds the UI once, then serves UI + engine on http://localhost:8000
set -euo pipefail
cd "$(dirname "$0")"
# The demo uses its own key, DME_ANTHROPIC_API_KEY, so it never bills a key that some other
# tool exported as ANTHROPIC_API_KEY. Reviewers without it can still set ANTHROPIC_API_KEY.
if [ -z "${DME_ANTHROPIC_API_KEY:-}" ] && [ -f "$HOME/.secrets.personal" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.secrets.personal"
fi
if [ -z "${DME_ANTHROPIC_API_KEY:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Set DME_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY) first; live runs make real model calls." >&2
  echo "Without a key you can still watch the recorded replay: it needs no key." >&2
fi
if [ ! -f frontend/dist/index.html ]; then
  (cd frontend && npm ci && npm run build)
fi
cd backend
uv sync -q
echo "Open http://localhost:${PORT:-8000}"
exec uv run uvicorn dme.server.app:app --port "${PORT:-8000}"
