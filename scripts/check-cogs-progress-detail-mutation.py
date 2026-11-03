#!/usr/bin/env python3
"""Prove secret passthrough is caught in isolated copies, never in the live tree."""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="cogs-detail-mutation-") as tmp:
    isolated = Path(tmp)
    for folder in ("src", "hooks", "tests/hooks"):
        shutil.copytree(root / folder, isolated / folder)
    (isolated / "node_modules").symlink_to((root / "node_modules").resolve(), target_is_directory=True)
    source = isolated / "src/server/lib/cogsProgressDetail.ts"
    original = source.read_text()
    anchor = 'export function safeProgressDetail(value: unknown): string {\n'
    assert original.count(anchor) == 1
    source.write_text(original.replace(anchor, anchor + '  if (typeof value === "string" && value.includes("token=")) return value; // mutation\n'))
    result = subprocess.run(["bun", "test", "src/server/lib/cogsProgressDetail.test.ts", "src/server/routes/cogsProgress.test.ts"], cwd=isolated)
    assert result.returncode != 0, "server secret passthrough mutant survived"
    print("server secret passthrough mutant: caught", flush=True)
    hook = isolated / "hooks/telegram-progress.py"
    original = hook.read_text()
    anchor = 'def _cogs_detail(data):\n'
    assert original.count(anchor) == 1
    hook.write_text(original.replace(anchor, anchor + '    value = data.get("tool_input", {}).get("description", "")\n    if isinstance(value, str) and "token=" in value:\n        return value  # mutation\n'))
    result = subprocess.run(["python3", "-m", "unittest", "discover", "-s", "tests/hooks", "-p", "test_cogs_progress.py"], cwd=isolated)
    assert result.returncode != 0, "hook secret passthrough mutant survived"
    print("hook secret passthrough mutant: caught", flush=True)
