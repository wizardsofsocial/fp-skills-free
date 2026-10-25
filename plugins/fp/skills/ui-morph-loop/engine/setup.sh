#!/usr/bin/env bash
# One-time setup for the video engine. Safe to re-run: it only installs what's missing.
#   bash setup.sh            core: playwright + chromium, ffmpeg check, numpy
#   bash setup.sh --music    + faster-whisper (lyric alignment), demucs (vocal stems), edge-tts (free voice-over)
#   bash setup.sh --image    + rembg, onnxruntime, opencv, pillow (cutting a still image into layers)
#   bash setup.sh --all      everything above
set -euo pipefail
cd "$(dirname "$0")"
ok() { printf '  \033[32mok\033[0m  %s\n' "$1"; }
miss() { printf '  \033[33m--\033[0m  %s\n' "$1"; }

echo "video engine setup"
command -v node >/dev/null || { echo "Node.js 20+ is required: https://nodejs.org"; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "Node.js 20+ is required: https://nodejs.org (found $(node -v))"; exit 1; }
ok "node $(node -v)"

if [ ! -d node_modules/playwright ]; then
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --silent --no-audit --no-fund
fi
ok "playwright $(npx --no-install playwright --version 2>/dev/null | sed 's/^Version //')"

# Chromium: always ask Playwright for the exact build it expects. Any cached
# Chromium is not enough: a window that opens (the app-demo login) needs
# Playwright's own build of its own version. When that build is already in the
# cache this only checks it and downloads nothing.
# (Its stack trace lines on a failed download are left out; the error line stays.)
if npx --no-install playwright install chromium 2>&1 | { grep -v '^    at ' || true; }; then
  ok "chromium (the build this Playwright needs)"
else
  # Offline, or the download failed. Carry on only if some Chromium is usable.
  found=$(node -e 'import("./scripts/_common.mjs").then(m => console.log(m.findChrome() || ""))' 2>/dev/null || true)
  if [ -n "$found" ]; then
    miss "could not download the Chromium build this Playwright needs (offline?). Rendering and headless recording use the Chromium already here, but a window that opens (the app-demo login) needs that build: run this setup again when you are online."
  else
    echo "No usable Chromium and the download failed (offline?). Connect to the internet and run: bash $(pwd)/setup.sh"
    exit 1
  fi
fi

if command -v ffmpeg >/dev/null; then ok "ffmpeg"; else
  miss "ffmpeg not found. Install it (macOS: brew install ffmpeg, Ubuntu: sudo apt install ffmpeg) or: pip install imageio-ffmpeg"; fi

PY=python3
$PY -c "import numpy" 2>/dev/null && ok "numpy" || { $PY -m pip install --quiet numpy && ok "numpy (installed)"; }

if [[ "${1:-}" == "--music" || "${1:-}" == "--all" ]]; then
  $PY -c "import faster_whisper" 2>/dev/null && ok "faster-whisper" || $PY -m pip install --quiet faster-whisper
  $PY -c "import demucs" 2>/dev/null && ok "demucs" || $PY -m pip install --quiet demucs
  $PY -c "import edge_tts" 2>/dev/null && ok "edge-tts" || $PY -m pip install --quiet edge-tts
fi
if [[ "${1:-}" == "--image" || "${1:-}" == "--all" ]]; then
  $PY -c "import PIL" 2>/dev/null && ok "pillow" || $PY -m pip install --quiet pillow
  $PY -c "import cv2" 2>/dev/null && ok "opencv" || $PY -m pip install --quiet opencv-python-headless
  $PY -c "import rembg" 2>/dev/null && ok "rembg" || $PY -m pip install --quiet "rembg[cpu]"
fi
if [[ "${1:-}" == "--all" ]]; then
  $PY -c "import librosa" 2>/dev/null && ok "librosa" || $PY -m pip install --quiet librosa
fi
$PY -c "import edge_tts" 2>/dev/null && ok "edge-tts (free voice-over)" || miss "edge-tts (optional free voice-over): pip install edge-tts"
[ -n "${ELEVENLABS_API_KEY:-}" ] && ok "ELEVENLABS_API_KEY is set" || miss "ELEVENLABS_API_KEY not set (optional, for premium voice-over)"
echo "done"
