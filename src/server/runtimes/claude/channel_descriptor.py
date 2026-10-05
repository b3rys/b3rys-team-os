"""Shared Claude channel identity; installed beside hooks with its JSON mapping."""
import json
import os
import re
from pathlib import Path

_here = Path(__file__).resolve().parent
CHANNELS = json.loads((_here / "channel-descriptors.json").read_text())

def active_channel():
    # b3chat wins if a parent shell accidentally carried the Telegram state env.
    kind = "b3chat" if os.environ.get(CHANNELS["b3chat"]["stateEnv"]) else "telegram"
    return kind, CHANNELS[kind]

def channel_for_tag(tag):
    m = re.search(r'\bsource="([^"]+)"', tag)
    if not m:
        return None
    for kind, descriptor in CHANNELS.items():
        if m.group(1) in (descriptor["source"], descriptor["source"] + (":telegram" if kind == "telegram" else "")):
            return kind, descriptor
    return None

def is_group(kind, attrs, chat_id):
    if kind == "telegram":
        return str(chat_id).startswith("-")
    m = re.search(r'\bchat_type="([^"]+)"', attrs)
    # b3chat rooms have positive IDs: never guess DM from the sign.
    return not m or m.group(1) != "private"
