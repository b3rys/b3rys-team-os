#!/usr/bin/env python3
"""Prove privacy filters and rate limits in isolated copies, never in the live tree."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import re

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="cogs-detail-mutation-") as tmp:
    isolated = Path(tmp)
    for folder in ("src", "hooks", "tests/hooks"):
        shutil.copytree(root / folder, isolated / folder)
    (isolated / "node_modules").symlink_to((root / "node_modules").resolve(), target_is_directory=True)
    server_tests = ["bun", "test", "src/server/lib/cogsProgressDetail.test.ts", "src/server/routes/cogsProgress.test.ts"]
    hook_tests = ["python3", "-m", "unittest", "discover", "-s", "tests/hooks", "-p", "test_cogs_progress.py"]

    def run(command, label, failure=None):
        result = subprocess.run(command, cwd=isolated, capture_output=True, text=True)
        output = result.stdout + result.stderr
        if failure is None:
            assert result.returncode == 0, output
        else:
            assert result.returncode != 0 and failure in output, output
        summaries = re.findall(r"^.*(?:\d+ pass|\d+ fail|Ran \d+ tests|FAILED \(.*|^OK$).*$", output, re.M)
        print(label + ": " + " | ".join(s.strip() for s in summaries), flush=True)

    run(server_tests, "server baseline")
    run(hook_tests, "hook baseline")
    source = isolated / "src/server/lib/cogsProgressDetail.ts"
    original = source.read_text()
    anchor = 'export function safeProgressDetail(value: unknown, file = false): string {\n'
    assert original.count(anchor) == 1
    source.write_text(original.replace(anchor, anchor + '  return typeof value === "string" ? Array.from(value.trim()).slice(0, 45).join("") : ""; // mutation\n'))
    run(server_tests, "server privacy-filter removal caught", "(fail) review privacy cases")
    source.write_text(original)
    hook = isolated / "hooks/telegram-progress.py"
    original_hook = hook.read_text()
    anchor = 'def _cogs_detail(data):\n'
    assert original_hook.count(anchor) == 1
    bypass = '    args = data.get("tool_input", {})\n    value = args.get("description", "") if data.get("tool_name") == "Bash" else args.get("file_path", args.get("notebook_path", ""))\n    if isinstance(value, str):\n        if data.get("tool_name") != "Bash":\n            value = value.replace(chr(92), "/").rsplit("/", 1)[-1]\n        return value.strip()[:45]  # mutation\n'
    hook.write_text(original_hook.replace(anchor, anchor + bypass))
    run(hook_tests, "hook privacy-filter removal caught", "FAIL: test_review_privacy_cases_in_real_hook_payloads")
    hook.write_text(original_hook)
    typing = isolated / "src/server/lib/cogsTyping.ts"
    original_typing = typing.read_text()
    anchor = "progressIntervalMs: opts.progressIntervalMs ?? 1000"
    assert original_typing.count(anchor) == 1
    typing.write_text(original_typing.replace(anchor, "progressIntervalMs: opts.progressIntervalMs ?? 0"))
    run(server_tests, "one-second rate-limit removal caught", "(fail) default one-second throttle")
    typing.write_text(original_typing)
    run(server_tests, "restored server")
    run(hook_tests, "restored hook")
