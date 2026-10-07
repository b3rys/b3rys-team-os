#!/usr/bin/env python3
"""Return requests through the real producer/helper, using temporary libraries only."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

binary, producer = sys.argv[1:]
checks = 0

def check(value, label):
    global checks
    assert value, label
    checks += 1

def h(data):
    return hashlib.sha256(data).hexdigest()

with tempfile.TemporaryDirectory() as tmp:
    home = Path(tmp).resolve()
    lib = home / 'notes'
    team = lib / '팀 공유'
    team.mkdir(parents=True)
    (team / '.steno-folder').write_text('team')
    state = lib / '.steno'
    state.mkdir()
    shared = home / 'Library/Application Support/b3os/steno-shared'
    out = home / 'Library/Application Support/b3os/steno-share-outbox'
    shared.mkdir(parents=True)
    env = dict(os.environ, HOME=str(home), STENO_SHARE_NO_KICK='1')
    env.pop('STENO_SHARE_TEST_REFRESH', None)
    env.pop('STENO_TEST_APP_RUNNING', None)

    def request(name, original=b'original', edited=b'edited', source=None, base=None):
        (team / name).write_bytes(original)
        (shared / name).write_bytes(edited)
        manifest = {name: {'file': name, 'base': base or h(b'original'), 'source': source or h(original)}}
        (shared / '.manifest.json').write_text(json.dumps(manifest))
        subprocess.run([sys.executable, producer, name, '--as', '빌'], env=env, check=True, stdout=subprocess.DEVNULL)

    def upload(extra=None):
        subprocess.run([binary, '--upload', str(out), str(lib)], env=dict(env, **(extra or {})), check=True)

    request('same.md')
    check(len(list(out.glob('.return-*.json'))) == 1, 'producer queues helper request')
    upload()
    check((team / 'same.md').read_bytes() == b'edited', 'base equal replaces original')
    check(not list(out.iterdir()), 'successful return consumes request and payload')
    marks = json.loads((state / 'ai-edits.json').read_text())
    mark = marks['팀 공유/same.md']
    check(mark['editor'] == '빌' and mark['fileNumber'] == (team / 'same.md').stat().st_ino, 'AIEditMark editor and inode')
    backup = Path(mark['backup'])
    check(backup.read_bytes() == b'original', 'backup exact original bytes')
    meta = json.loads(Path(str(backup) + '.steno-meta.json').read_text())
    check(meta['editedBy'] == '빌' and meta['originalPath'] == str(team / 'same.md'), 'archive sidecar protocol')
    check((team / 'same.md').stat().st_mode & 0o777 == 0o600, 'return mode 0600')

    request('conflict.md', original=b'changed')
    upload()
    check((team / 'conflict.md').read_bytes() == b'changed', 'base mismatch original untouched')
    check((team / 'conflict (빌 수정).md').read_bytes() == b'edited', 'base mismatch produces edited copy')

    # A real live pid, not a mocked liveness result. ps reports start to whole seconds.
    start = subprocess.check_output(['ps', '-p', str(os.getpid()), '-o', 'lstart='], text=True).strip()
    epoch = datetime.datetime.strptime(start, '%a %b %d %H:%M:%S %Y').timestamp()
    record = {'pid': os.getpid(), 'processStart': epoch, 'updatedAt': '2026-10-07T00:00:00Z',
              'held': [str(team / 'held.md')], 'current': str(team / 'held.md')}
    (state / 'open-notes.json').write_text(json.dumps(record))
    request('held.md'); upload()
    check((team / 'held.md').read_bytes() == b'original', 'held + live pid original untouched')
    check((team / 'held (빌 수정).md').read_bytes() == b'edited', 'held note produces copy')

    (state / 'open-notes.json').write_text('broken')
    request('broken.md'); upload()
    check((team / 'broken.md').read_bytes() == b'original', 'unreadable state original untouched')
    check((team / 'broken (빌 수정).md').exists(), 'unreadable state produces copy')
    (state / 'open-notes.json').unlink()
    request('unknown.md'); upload({'STENO_TEST_APP_RUNNING': '1'})
    check((team / 'unknown.md').read_bytes() == b'original', 'running app missing state original untouched')
    check((team / 'unknown (빌 수정).md').exists(), 'running app missing state produces copy')

    record['pid'] = 2147483647
    (state / 'open-notes.json').write_text(json.dumps(record))
    request('dead.md'); upload()
    check((team / 'dead.md').read_bytes() == b'edited', 'dead pid permits replacement')
    (state / 'open-notes.json').unlink()

    (state / 'ai-edits.json').write_text('broken')
    request('bad-marks.md'); upload()
    check((team / 'bad-marks.md').read_bytes() == b'original', 'malformed marks never overwritten')
    check((state / 'ai-edits.json').read_text() == 'broken', 'existing malformed marks retained')
    (state / 'ai-edits.json').write_text(json.dumps(marks))
    request('conflict.md', original=b'changed'); upload()
    check((team / 'conflict (빌 수정) 2.md').exists(), 'conflict copy collision suffix')

    # Baseline hash is checked by helper, not trusted from manifest source.
    request('queued-race.md')
    (team / 'queued-race.md').write_bytes(b'changed after enqueue')
    upload()
    check((team / 'queued-race.md').read_bytes() == b'changed after enqueue', 'queued race cannot clobber new original')
    check((team / 'queued-race (빌 수정).md').read_bytes() == b'edited', 'queued race produces copy')

    (shared / 'noop.md').write_bytes(b'original')
    (shared / '.manifest.json').write_text(json.dumps({'noop.md': {'base': h(b'original'), 'source': h(b'newer')}}))
    subprocess.run([sys.executable, producer, 'noop.md', '--as', '빌'], env=env, check=True, stdout=subprocess.DEVNULL)
    check(not list(out.iterdir()), 'unchanged copy queues nothing')
    for bad in ['../x', '.hidden', 'a/b', '1234567890123456789012345']:
        result = subprocess.run([sys.executable, producer, 'noop.md', '--as', bad], env=env, capture_output=True)
        check(result.returncode != 0, 'bad member rejected ' + bad)

print(f'PASS: {checks} helper return checks')
