#!/usr/bin/env bash
# MOSS Prompt Studio - macOS / Linux launcher
#   ./start.sh            native window (pywebview)
#   ./start.sh --browser  system browser
#   ./start.sh --debug    devtools
set -e
cd "$(dirname "$0")"
PY=""
for v in python3.12 python3.11 python3.13 python3; do
  if command -v "$v" >/dev/null 2>&1 && "$v" -c 'import sys; sys.exit(0 if (3,11)<=sys.version_info[:2]<=(3,13) else 1)' 2>/dev/null; then PY="$v"; break; fi
done
[ -z "$PY" ] && { echo "Need Python 3.11-3.13"; exit 1; }
[ -x .venv/bin/python ] || "$PY" -m venv .venv
if ! cmp -s requirements.txt .venv/.req-stamp; then
  .venv/bin/python -m pip install -q -U pip
  .venv/bin/python -m pip install -q -r requirements.txt
  cp requirements.txt .venv/.req-stamp
fi
if [ ! -f dist/index.html ]; then
  command -v npm >/dev/null || { echo "dist/ missing and npm not found"; exit 1; }
  [ -d node_modules ] || npm install
  npm run build
fi
exec .venv/bin/python -m desktop "$@"
