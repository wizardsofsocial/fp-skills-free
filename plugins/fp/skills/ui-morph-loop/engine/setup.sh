#!/usr/bin/env bash
# One-time setup for the video engine. Safe to re-run: it only installs what's missing.
#   bash setup.sh            core: playwright + chromium, ffmpeg check, numpy
#   bash setup.sh --music    + faster-whisper (lyric alignment), demucs (vocal stems), edge-tts (free voice-over)
#   bash setup.sh --all      everything above
set -euo pipefail
cd "$(dirname "$0")"
ok() { printf '  \033[32mok\033[0m  %s\n' "$1"; }
miss() { printf '  \033[33m--\033[0m  %s\n' "$1"; }

echo "video engine setup"
command -v node >/dev/null || { echo "Node.js 18+ is required: https://nodejs.org"; exit 1; }
ok "node $(node -v)"

if [ ! -d node_modules/playwright ]; then
  # reuse an existing browser download if there is one, else fetch chromium once
  if ls "$HOME/Library/Caches/ms-playwright" "$HOME/.cache/ms-playwright" 2>/dev/null | grep -q chromium; then
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --silent --no-audit --no-fund
  else
    npm install --silent --no-audit --no-fund && npx playwright install chromium
  fi
fi
ok "playwright"

if command -v ffmpeg >/dev/null; then ok "ffmpeg"; else
  miss "ffmpeg not found. Install it (macOS: brew install ffmpeg, Ubuntu: sudo apt install ffmpeg) or: pip install imageio-ffmpeg"; fi

PY=python3
$PY -c "import numpy" 2>/dev/null && ok "numpy" || { $PY -m pip install --quiet numpy && ok "numpy (installed)"; }

if [[ "${1:-}" == "--music" || "${1:-}" == "--all" ]]; then
  $PY -c "import faster_whisper" 2>/dev/null && ok "faster-whisper" || $PY -m pip install --quiet faster-whisper
  $PY -c "import demucs" 2>/dev/null && ok "demucs" || $PY -m pip install --quiet demucs
  $PY -c "import edge_tts" 2>/dev/null && ok "edge-tts" || $PY -m pip install --quiet edge-tts
fi
if [[ "${1:-}" == "--all" ]]; then
  $PY -c "import librosa" 2>/dev/null && ok "librosa" || $PY -m pip install --quiet librosa
fi
$PY -c "import edge_tts" 2>/dev/null && ok "edge-tts (free voice-over)" || miss "edge-tts (optional free voice-over): pip install edge-tts"
[ -n "${ELEVENLABS_API_KEY:-}" ] && ok "ELEVENLABS_API_KEY is set" || miss "ELEVENLABS_API_KEY not set (optional, for premium voice-over)"
echo "done"
