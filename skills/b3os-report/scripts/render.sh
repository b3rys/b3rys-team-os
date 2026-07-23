#!/usr/bin/env bash
# b3os-report 렌더 래퍼: MD → 아이폰 반응형 HTML+SVG (자체완결).
# 사용: render.sh <input.md> [output.html] [제목]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IN="${1:?usage: render.sh <input.md> [out.html] [title]}"
OUT="${2:-${IN%.md}.html}"
TITLE="${3:-}"
RUN=$(command -v bun || command -v node)
if [ -n "$TITLE" ]; then "$RUN" "$HERE/render.mjs" "$IN" "$OUT" --title "$TITLE"
else "$RUN" "$HERE/render.mjs" "$IN" "$OUT"; fi
