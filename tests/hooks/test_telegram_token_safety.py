"""Local-only Telegram hook regressions; no credentials or Telegram traffic."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.parse import parse_qs

ROOT = Path(__file__).resolve().parents[2]
TOKEN = '123456:FAKE_TOKEN_FOR_ARGV_REGRESSION'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'hooks' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TokenSafetyTests(unittest.TestCase):
    def test_detached_edit_argv_delivery_and_latency(self):
        progress = load('progress', 'telegram-progress.py')
        received = threading.Event()
        release = threading.Event()
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append((self.path, parse_qs(self.rfile.read(
                    int(self.headers['Content-Length'])).decode())))
                received.set()
                release.wait(4)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        original = subprocess.Popen
        children = []
        remote = 'https://api.telegram.org'
        local = f'http://127.0.0.1:{server.server_port}'

        def local_only_popen(argv, **kwargs):
            # Rewrite only the destination. Exercise the real curl and inherited stdin.
            argv = [arg.replace(remote, local) for arg in argv]
            stdin = kwargs.get('stdin')
            if stdin is not None:
                config = stdin.read().decode().replace(remote, local)
                stdin.seek(0)
                stdin.truncate()
                self.assertNotIn(remote, config)
                stdin.write(config.encode())
                stdin.seek(0)
            else:
                # Also routes the pre-fix implementation exclusively to loopback.
                self.assertTrue(any(local in arg for arg in argv))
            self.assertFalse(any(remote in arg for arg in argv))
            kwargs['env'] = dict(os.environ, NO_PROXY='*', no_proxy='*')
            child = original(argv, **kwargs)
            children.append(child)
            return child

        # Long and non-ASCII text also guards against a blocking stdin pipe and encoding loss.
        text = '진행 "상태"\n\\ & + ' + TOKEN + '가' * 20000
        try:
            with patch.dict(os.environ, {'TG_PROGRESS_SYNC': '0'}), \
                    patch.object(progress.subprocess, 'Popen', local_only_popen):
                start = time.monotonic()
                progress.tg_edit(TOKEN, '-123', 456, text)
                elapsed = time.monotonic() - start
            self.assertEqual(len(children), 1)
            self.assertLess(elapsed, 0.25, 'edit waited for network')
            self.assertTrue(received.wait(3), 'fake server did not receive edit')
            child = children[0]
            self.assertIsNone(child.poll(), 'child must stay alive during argv inspection')
            argv = subprocess.check_output(
                ['ps', '-ww', '-p', str(child.pid), '-o', 'command='], text=True)
            self.assertFalse(TOKEN in argv, 'bot token exposed in live child argv')
            self.assertEqual(requests, [(f'/bot{TOKEN}/editMessageText', {
                'chat_id': ['-123'], 'message_id': ['456'], 'text': [text]})])
            print(f'detached edit return: {elapsed * 1000:.2f} ms (server response held)')
        finally:
            release.set()
            for child in children:
                child.wait(timeout=6)
            server.shutdown()
            server.server_close()
            thread.join()

    def test_progress_urllib_errors_do_not_escape_or_print_urls(self):
        progress = load('progress_errors', 'telegram-progress.py')
        output = io.StringIO()
        with patch('urllib.request.urlopen', side_effect=ValueError(
                f'https://api.telegram.org/bot{TOKEN}/failure')), \
                patch.dict(os.environ, {'TG_PROGRESS_SYNC': '1'}), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            self.assertIsNone(progress.tg_send(TOKEN, '-1', 'test'))
            progress.tg_delete(TOKEN, '-1', 2)
            progress.tg_react(TOKEN, '-1', 2, '👀')
            progress.tg_edit(TOKEN, '-1', 2, 'test')
        self.assertEqual(output.getvalue(), '')

    def test_owner_gate_does_not_log_exception_url_or_prompt(self):
        gate = load('owner_gate', 'telegram-owner-gate.py')
        prompt = f'<channel source="telegram" chat_id="-1" message_id="2">{TOKEN}</channel>'
        for decision in (None, {'suppress': True, 'reason': TOKEN, 'targetAgentIds': [TOKEN]}):
            with self.subTest(error=decision is None), tempfile.TemporaryDirectory() as tmp:
                log = Path(tmp) / 'owner.log'
                output = io.StringIO()
                response = io.BytesIO(json.dumps(decision).encode())
                with patch.object(gate, 'SELF_ID', 'test-agent'), \
                        patch.dict(os.environ, {'OWNER_GATE_LOG': str(log)}), \
                        patch('sys.stdin', io.StringIO(json.dumps({'prompt': prompt}))), \
                        patch('urllib.request.urlopen', side_effect=(
                            ValueError(f'https://api.telegram.org/bot{TOKEN}/failure')
                            if decision is None else None), return_value=response), \
                        contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                    with self.assertRaises(SystemExit) as exit_result:
                        gate.main()
                self.assertEqual(exit_result.exception.code, 0)
                self.assertFalse(TOKEN in log.read_text() + output.getvalue(),
                                 'token leaked through owner-gate diagnostics')
                if decision is not None:
                    self.assertEqual(json.loads(output.getvalue())['decision'], 'block')


if __name__ == '__main__':
    unittest.main()
