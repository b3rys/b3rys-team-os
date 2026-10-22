import importlib.util
from pathlib import Path
import sqlite3
import os
import time
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('stall', Path(__file__).with_name('liveness-pane-stall.py'))
stall = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stall)


class PaneStallTest(unittest.TestCase):
    def test_twenty_minutes_with_pending_and_no_progress(self):
        first, alert = stall.observe({}, 'PreToolUse hook', 'bus:one', 'session', 100)
        self.assertFalse(alert)
        self.assertFalse(stall.observe(first, 'PreToolUse hook', 'bus:one', 'session', 1299)[1])
        self.assertTrue(stall.observe(first, 'PreToolUse hook', 'bus:one', 'session', 1300)[1])
        self.assertTrue(stall.observe(first, 'unknown screen', 'bus:one', 'session', 1300)[0]['since'] == 1300)

    def test_progress_new_message_restart_idle_and_empty_pane_reset(self):
        first, _ = stall.observe({}, 'hook', 'bus:one', 'session', 100)
        for pane, pending, session in [('new output', 'bus:one', 'session'),
                                       ('hook', 'bus:two', 'session'),
                                       ('hook', 'bus:one', 'restart'),
                                       ('hook', '', 'session'), ('', 'bus:one', 'session')]:
            with self.subTest(pane=pane, pending=pending, session=session):
                self.assertFalse(stall.observe(first, pane, pending, session, 1400)[1])

    def test_unknown_screen_is_also_detected(self):
        first, _ = stall.observe({}, 'unrecognized', 'telegram:dm:12', 's', 0)
        self.assertTrue(stall.observe(first, 'unrecognized', 'telegram:dm:12', 's', 1200)[1])

    def test_pending_is_metadata_not_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            dbpath = Path(tmp) / 'team.db'
            hook = Path(tmp) / 'hook'
            hook.write_text('12:00:00 react send (injected) chat=123 msg=9\n')
            self.assertEqual(stall.pending_message(dbpath, 'member', hook), 'telegram:123:9')
            hook.write_text(hook.read_text() + '12:01:00 clear src=reply\n')
            self.assertEqual(stall.pending_message(dbpath, 'member', hook), '')
            with sqlite3.connect(dbpath) as db:
                db.executescript('''CREATE TABLE message(id, created_at, delivery_status, expires_at);
                    CREATE TABLE message_recipient(message_id, agent_id, recipient_state, close_reason);
                    INSERT INTO message VALUES ('one', '2026-01-01', 'delivered', NULL);
                    INSERT INTO message_recipient VALUES ('one', 'member', 'in_progress', NULL);''')
            self.assertEqual(stall.pending_message(dbpath, 'member', hook), 'bus:one')
            self.assertEqual(stall.pending_message(dbpath, 'other', hook), '')
            with sqlite3.connect(dbpath) as db:
                db.execute("UPDATE message_recipient SET recipient_state = 'acknowledged', close_reason = 'broadcast_fyi'")
            self.assertEqual(stall.pending_message(dbpath, 'member', hook), '')
            with sqlite3.connect(dbpath) as db:
                db.execute("UPDATE message_recipient SET recipient_state = 'completed', close_reason = NULL")
            self.assertEqual(stall.pending_message(dbpath, 'member', hook), '')


    def test_reactions_before_current_session_are_not_pending(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / 'hook'
            now = time.time()
            log.write_text(time.strftime('%H:%M:%S', time.localtime(now - 7200)) + ' react send chat=123 msg=9\n'
                           + time.strftime('%H:%M:%S', time.localtime(now)) + ' pre first-send mid=10\n')
            self.assertEqual(stall.pending_message(Path(tmp) / 'missing.db', 'member', log, now - 60), '')
            log.write_text(time.strftime('%H:%M:%S', time.localtime(now)) + ' react send chat=123 msg=10\n')
            self.assertEqual(stall.pending_message(Path(tmp) / 'missing.db', 'member', log, now - 60), 'telegram:123:10')


if __name__ == '__main__':
    unittest.main()
