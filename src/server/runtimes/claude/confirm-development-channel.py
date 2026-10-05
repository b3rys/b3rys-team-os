#!/usr/bin/env python3
"""Confirm ONLY the local b3chat development-channel dialog, once.

No trust, permission-mode, login or MCP approval prompts are accepted here.
UI strings verified against the installed CLI bundle (without running Claude).
"""
import re
import subprocess
import sys
import time

def is_development_warning(pane):
    lines = [line.strip().strip("│ ") for line in pane.splitlines()]
    return (
        "WARNING: Loading development channels" in lines
        and any(line == "Channels: server:b3chat" for line in lines)
        and any(re.fullmatch(r"(?:[❯>●] )?(?:1[.)] )?I am using this for local development", line) for line in lines)
        and not any("Bypass Permissions" in line or "trust this folder" in line.lower() for line in lines)
    )

def confirm(session, attempts=60, delay=0.5):
    for _ in range(attempts):
        pane = subprocess.run(["tmux", "capture-pane", "-p", "-t", session], capture_output=True, text=True)
        if pane.returncode != 0:
            return False
        if is_development_warning(pane.stdout):
            # Select option 1 explicitly, never Enter on an unknown/default option.
            return subprocess.run(["tmux", "send-keys", "-t", session, "1", "Enter"], capture_output=True).returncode == 0
        time.sleep(delay)
    return False

if __name__ == "__main__":
    if not confirm(sys.argv[1]):
        print("b3chat development warning not confirmed; no keys sent", file=sys.stderr)
        sys.exit(1)
