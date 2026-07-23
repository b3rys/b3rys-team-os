#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
received = {}

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('content-length', '0'))
        received['path'] = self.path
        received['payload'] = json.loads(self.rfile.read(length))
        body = json.dumps({'ok': True}).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, format, *args):
        pass

with tempfile.TemporaryDirectory(prefix='b3os-report-publish-test-') as td:
    root = Path(td)
    md = root / 'source.md'; md.write_text('# source\n', encoding='utf-8')
    html = root / 'source.html'; html.write_text('<!doctype html><title>source</title>', encoding='utf-8')
    server = HTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.handle_request, daemon=True); thread.start()
    env = os.environ.copy()
    env['TEAM_COLLAB_DIR'] = str(root / 'team')
    env['TEAM_BASE'] = f'http://127.0.0.1:{server.server_port}'
    proc = subprocess.run([
        str(HERE / 'publish.sh'), '--title', 'Test', '--author', 'ames', '--summary', 'test',
        '--md', str(md), '--html', str(html), '--id', 'publish-order-test'
    ], env=env, text=True, capture_output=True, check=True)
    thread.join(timeout=5); server.server_close()
    payload = received['payload']
    assert received['path'] == '/reports/api/register'
    assert [f['type'] for f in payload['forms']] == ['html', 'md'], payload['forms']
    assert (root / 'team/reports/publish-order-test/report.html').exists()
    assert (root / 'team/reports/publish-order-test/report.md').exists()
    assert 'forms=html,md' in proc.stdout
    print('PASS b3os-report publish defaults to HTML then MD')
