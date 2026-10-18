#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

PORT="${PORT:-8787}"
DEV="${DEV:-0}"

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi
.venv/bin/pip install -q -r server/requirements.txt

if [[ ! -d node_modules ]]; then
  npm install
fi

if [[ "$DEV" == "1" ]]; then
  echo "==> Dev mode: API :$PORT + Vite :5173"
  .venv/bin/uvicorn server.main:app --host 0.0.0.0 --port "$PORT" --reload &
  API_PID=$!
  trap 'kill $API_PID 2>/dev/null || true' EXIT
  npm run dev -- --host 0.0.0.0 --port 5173
else
  echo "==> Building frontend…"
  npm run build
  echo "==> Serving on http://0.0.0.0:$PORT"
  exec .venv/bin/uvicorn server.main:app --host 0.0.0.0 --port "$PORT"
fi
