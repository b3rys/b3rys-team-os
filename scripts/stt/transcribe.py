"""Offline-only MLX adapter. Output exists only after successful transcription."""
import os
import sys
from pathlib import Path

# Set before importing Hugging Face, regardless of the service environment.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["PATH"] = "/opt/homebrew/bin:" + os.environ.get("PATH", "")

import mlx_whisper


def main():
    audio, model, output, prompt = sys.argv[1:]
    model_path = Path(model)
    if not (model_path / "config.json").is_file() or not (model_path / "weights.safetensors").is_file():
        raise RuntimeError("local voice model missing")
    result = mlx_whisper.transcribe(
        audio, path_or_hf_repo=str(model_path), language="ko",
        initial_prompt=prompt[:1000], verbose=False,
    )
    text = result["text"].strip()
    if not text:
        raise RuntimeError("local voice result empty")
    Path(output).write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
