#!/usr/bin/env bash
set -euo pipefail
BASE="${1:-http://127.0.0.1:8787}"
curl -sf "$BASE/api/health" >/dev/null
RESP=$(curl -sf "$BASE/api/compile" -H 'Content-Type: application/json' -d '{
  "draft": {
    "width": 1536, "height": 1024,
    "bbox_coord_space": "abs", "bbox_format": "xyxy",
    "summary": {"caption": "A ceramic campaign.", "canvas": "single"},
    "items": [{"label": "object", "caption": "Cup", "bbox": [176, 224, 800, 864]}]
  }
}')
echo "$RESP" | grep -q abs_centralized
echo "$RESP" | grep -q '"mode":"layout"'
echo "smoke_compile OK"
