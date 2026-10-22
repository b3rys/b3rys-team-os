#!/usr/bin/env python3
"""Observe a local Telegram pane while a DM or bus message awaits a reply."""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import time


def pending_message(db_path, agent, channel_dir, session_start=0):
    try:
        with sqlite3.connect(Path(db_path).resolve().as_uri() + '?mode=ro', uri=True, timeout=1) as db:
            row = db.execute('''SELECT m.id FROM message_recipient r
                JOIN message m ON m.id = r.message_id
                WHERE r.agent_id = ?
                  AND r.recipient_state IN ('open', 'acknowledged', 'in_progress')
                  AND COALESCE(r.close_reason, '') != 'broadcast_fyi'
                  AND m.delivery_status IN ('pending', 'delivered')
                  AND (m.expires_at IS NULL OR julianday(m.expires_at) > julianday('now'))
                ORDER BY m.created_at, m.id LIMIT 1''', (agent,)).fetchone()
            if row:
                return 'bus:' + row[0]
    except (sqlite3.Error, ValueError):
        pass
    turns = []
    for path in (Path(channel_dir) / 'turnch').glob('*.json'):
        try:
            turn = json.loads(path.read_text())
            started = float(turn['ts'])
            if session_start <= started <= time.time() and turn.get('chat_id') and turn.get('message_id'):
                turns.append((started, 'telegram:' + str(turn['chat_id']) + ':' + str(turn['message_id'])))
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return min(turns)[1] if turns else ''


def observe(previous, pane, pending, session, now):
    if not pending or not pane.strip():
        return {}, False
    digest = hashlib.sha256(pane.encode()).hexdigest()
    same = (previous.get('pane') == digest and previous.get('pending') == pending
            and previous.get('session') == session)
    since = previous.get('since', now) if same else now
    if not isinstance(since, (float, int)) or since > now:
        since = now
    state = dict(pane=digest, pending=pending, session=session, since=since)
    return state, now - since >= 1200


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('state', 'db', 'agent', 'channel-dir', 'session'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    path = Path(args.state)
    try:
        previous = json.loads(path.read_text())
        if not isinstance(previous, dict):
            previous = {}
    except (OSError, ValueError):
        previous = {}
    state, stalled = observe(previous, sys.stdin.read(),
                             pending_message(args.db, args.agent, args.channel_dir,
                                             float(args.session) if args.session.isdigit() else time.time()),
                             args.session, time.time())
    if not args.dry_run:
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(state))
        temporary.replace(path)
    if stalled:
        print('stalled')


if __name__ == '__main__':
    main()
