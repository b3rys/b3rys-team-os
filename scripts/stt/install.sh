#!/usr/bin/env bash
# Prepare the engine/model without changing or restarting the running service.
set -euo pipefail
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo 'Apple Silicon macOS required' >&2; exit 1; }
command -v uv >/dev/null
[[ -x /opt/homebrew/bin/ffmpeg ]] || { echo 'Install ffmpeg with Homebrew first' >&2; exit 1; }
STT_ROOT="${B3OS_STT_HOME:-$HOME/.local/share/b3os-stt}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$STT_ROOT"
uv venv --python 3.12 --allow-existing "$STT_ROOT/.venv"
uv pip sync --python "$STT_ROOT/.venv/bin/python" "$HERE/requirements.txt"
# Installation is the only network-enabled step. Pin weights as well as packages.
HF_HUB_OFFLINE=0 "$STT_ROOT/.venv/bin/python" - "$STT_ROOT/model" <<'PY'
import sys
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id="mlx-community/whisper-large-v3-turbo",
    revision="a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb",
    local_dir=sys.argv[1], allow_patterns=["config.json", "weights.safetensors"],
)
PY
install -m 644 "$HERE/transcribe.py" "$STT_ROOT/transcribe.py"
# Exercise model loading and decoding with a local fixture while HF is offline.
PROBE="$(mktemp -d)"
trap 'rm -rf "$PROBE"' EXIT
/usr/bin/say -v Yuna -o "$PROBE/voice.aiff" '받아쓰기 설치 확인입니다.'
HF_HUB_OFFLINE=1 "$STT_ROOT/.venv/bin/python" "$STT_ROOT/transcribe.py" \
  "$PROBE/voice.aiff" "$STT_ROOT/model" "$PROBE/voice.txt" ''
test -s "$PROBE/voice.txt"
printf 'Offline transcription verified. Engine installed at %s\n' "$STT_ROOT"
