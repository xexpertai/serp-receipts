#!/usr/bin/env bash
# Demo video: real two-agent MCP session (scripts/demo.ts) -> narration (Kokoro af_heart) -> footage -> assemble -> QA.
# Usage: scripts/video/make.sh [out.mp4]
set -euo pipefail
cd "$(dirname "$0")/../.."
PY=${VIDEO_PY:-$HOME/workspace/.video-venv/bin/python}
B=video/build; OUT=${1:-$B/serp-receipts-demo.mp4}
mkdir -p $B
[ -f $B/transcript.json ] || npx tsx scripts/demo.ts > $B/demo.log
"$PY" scripts/video/tts.py video/story.json $B
PLAYWRIGHT_FROM=${PLAYWRIGHT_FROM:-$HOME/workspace/serpapi-india} node scripts/video/footage.mjs video/story.json $B
"$PY" scripts/video/assemble.py video/story.json $B "$OUT"
"$PY" scripts/video/qa.py "$OUT" $B/qa
