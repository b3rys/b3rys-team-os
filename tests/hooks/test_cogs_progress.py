"""Exercise existing hook events with isolated state and loopback-only transport."""
import contextlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('progress', ROOT / 'hooks/telegram-progress.py')
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)
COGS = '<external_message source="cogs">[cogs chat_id=42, sender_id=7]\nhello</external_message>'


class CogsProgressTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        env = patch.dict(os.environ, TELEGRAM_STATE_DIR=self.temp.name, OWNER_GATE_SELF='testmate', B3OS_COGS_PROGRESS='1')
        env.start()
        self.addCleanup(env.stop)
        token = patch.object(hook, 'read_token', return_value=None)
        token.start()
        self.addCleanup(token.stop)

    def event(self, mode, **data):
        with patch.object(hook.sys, 'argv', ['hook', mode]), patch.object(hook.sys, 'stdin', io.StringIO(json.dumps({'session_id': 'test-session', **data}))):
            hook.main()

    def test_cogs_turn_posts_once_without_telegram(self):
        self.event('react', prompt=COGS)
        with patch.object(http.client, 'HTTPConnection') as connect, patch.object(hook, 'format_line', side_effect=AssertionError('Telegram path')):
            self.event('pre', tool_name='Bash', tool_input={'command': 'private fixture'})
        connect.assert_called_once_with('127.0.0.1', 7878, timeout=0.8)
        calls = connect.return_value.request.call_args_list
        self.assertEqual(len(calls), 1)
        args = calls[0].args
        self.assertEqual(args[:2], ('POST', '/team/api/cogs/progress'))
        self.assertEqual(json.loads(args[2]), {'agent': 'testmate', 'chat_id': '42', 'session_id': 'test-session', 'tool_name': 'Bash', 'tool_input': {'command': 'private fixture'}})
        connect.return_value.close.assert_called_once()

    def test_non_cogs_turn_clears_previous_channel_and_never_posts(self):
        for prompt in ['plain local prompt', '<external_message source="bus">[cogs chat_id=42, sender_id=7]</external_message>', '<channel source="telegram" chat_id="-99" message_id="1">hello</channel>']:
            with self.subTest(prompt=prompt):
                self.event('react', prompt=COGS)
                self.event('react', prompt=prompt)
                with patch.object(http.client, 'HTTPConnection') as connect:
                    self.event('pre', tool_name='Read', tool_input={'file_path': 'a.ts'})
                connect.assert_not_called()

    def test_group_and_session_isolation(self):
        self.event('react', prompt=COGS.replace('cogs chat_id', 'cogs group chat_id'))
        self.assertEqual(hook.load_state(hook._turnch_path(self.temp.name, 'test-session'))['chat_id'], '42')
        with patch.object(http.client, 'HTTPConnection') as connect:
            self.event('pre', session_id='other', tool_name='Read')
        connect.assert_not_called()

    def test_disabled_and_missing_identity_never_post(self):
        self.event('react', prompt=COGS)
        for env in [{'B3OS_COGS_PROGRESS': '0'}, {'OWNER_GATE_SELF': ''}]:
            with patch.dict(os.environ, env), patch.object(http.client, 'HTTPConnection') as connect:
                self.event('pre', tool_name='Read')
            connect.assert_not_called()

    def test_stop_clears_turn_and_compact_does_not_use_telegram(self):
        self.event('react', prompt=COGS)
        with patch.object(hook, 'parse_chat', side_effect=AssertionError('Telegram compact')):
            self.event('compact')
        self.event('stop')
        self.assertEqual(hook.load_state(hook._turnch_path(self.temp.name, 'test-session')), {})

    def test_closed_server_is_silent_and_returns_within_one_second(self):
        self.event('react', prompt=COGS)
        # Bound, non-listening socket: real refusal, cannot reach the live server.
        with socket.socket() as reserved:
            reserved.bind(('127.0.0.1', 0))
            port = reserved.getsockname()[1]
            original = http.client.HTTPConnection
            def local(host, _port, **kwargs):
                return original(host, port, **kwargs)
            out, err = io.StringIO(), io.StringIO()
            start = time.monotonic()
            with patch.object(http.client, 'HTTPConnection', side_effect=local), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                self.event('pre', tool_name='Bash', tool_input={'command': 'private fixture'})
            elapsed = time.monotonic() - start
        self.assertLess(elapsed, 1.0)
        self.assertEqual(out.getvalue() + err.getvalue(), '')
        print(f'closed-server elapsed={elapsed:.6f}s')

    def test_transport_timeout_is_ignored_without_diagnostics(self):
        self.event('react', prompt=COGS)
        with patch.object(http.client, 'HTTPConnection') as connect:
            connect.return_value.getresponse.side_effect = TimeoutError('private fixture')
            with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
                self.event('pre', tool_name='Bash')
            self.assertEqual(out.getvalue() + err.getvalue(), '')
            connect.return_value.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
