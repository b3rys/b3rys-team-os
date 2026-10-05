#!/usr/bin/env python3
"""Run a b3chat-only Claude process without inherited Telegram credentials."""
import os
import sys


def isolated_environment(env):
    return {key: value for key, value in env.items() if not key.startswith("TELEGRAM_")}


def launch(argv):
    if not argv:
        raise ValueError("missing Claude command")
    os.execvpe(argv[0], argv, isolated_environment(os.environ))


if __name__ == "__main__":
    launch(sys.argv[1:])
