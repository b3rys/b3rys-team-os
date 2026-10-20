"""Adapter contract tests with a fake MLX module; no model or network needed."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ADAPTER = Path(__file__).with_name("transcribe.py")


class AdapterTest(unittest.TestCase):
    def run_adapter(self, result, complete=True):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            model = root / "model"
            model.mkdir()
            (model / "config.json").write_text("{}")
            if complete:
                (model / "weights.safetensors").touch()
            (root / "mlx_whisper.py").write_text('''
import os, json
from pathlib import Path
def transcribe(audio, **kw):
    assert os.environ['HF_HUB_OFFLINE'] == '1'
    assert os.environ['HF_HUB_DISABLE_TELEMETRY'] == '1'
    assert kw['language'] == 'ko'
    assert kw['initial_prompt'] == '빌' * 1000
    assert Path(kw['path_or_hf_repo']).is_dir()
    return json.loads(os.environ['FAKE_RESULT'])
''')
            output = root / "output.txt"
            run = subprocess.run(
                [sys.executable, str(ADAPTER), str(root / "audio.ogg"), str(model), str(output), "빌" * 1100],
                env={**os.environ, "PYTHONPATH": name, "HF_HUB_OFFLINE": "0", "FAKE_RESULT": json.dumps(result)},
                capture_output=True,
            )
            return run.returncode, output.read_text() if output.exists() else None

    def test_offline_prompt_and_output(self):
        self.assertEqual(self.run_adapter({"text": " 빌, 확인 "}), (0, "빌, 확인"))

    def test_empty_result_fails_without_output(self):
        code, text = self.run_adapter({"text": " "})
        self.assertNotEqual(code, 0)
        self.assertIsNone(text)

    def test_incomplete_local_model_fails_without_output(self):
        code, text = self.run_adapter({"text": "빌"}, complete=False)
        self.assertNotEqual(code, 0)
        self.assertIsNone(text)


if __name__ == "__main__":
    unittest.main()
