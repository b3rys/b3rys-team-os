#!/usr/bin/env python3
"""Run the real producer/helper with temporary libraries: returns only create copies."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unicodedata
import uuid

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

    def request(name, original=b'original', edited=b'edited'):
        (team / name).write_bytes(original)
        (shared / name).write_bytes(edited)
        (shared / '.manifest.json').write_text(json.dumps({unicodedata.normalize('NFC', name): {
            'file': name, 'base': h(b'original'), 'source': h(original)}}))
        subprocess.run([sys.executable, producer, name, '--as', '빌'], env=env,
                       check=True, stdout=subprocess.DEVNULL)

    def upload(success=True):
        result = subprocess.run([binary, '--upload', str(out), str(lib)], env=env, capture_output=True)
        check((result.returncode == 0) == success, 'upload expected result: ' + result.stderr.decode())

    for mode in ['absent', 'closed', 'held', 'remote', 'broken', 'unreadable']:
        name = mode + '.md'
        record = {'host': 'other-mac' if mode == 'remote' else 'this-mac', 'pid': os.getpid(),
                  'processStart': 0, 'updatedAt': '2026-10-07T00:00:00Z',
                  'held': [] if mode == 'closed' else [str(team / name)]}
        if mode == 'absent':
            (state / 'open-notes.json').unlink(missing_ok=True)
        else:
            (state / 'open-notes.json').write_text('broken' if mode == 'broken' else json.dumps(record))
        if mode == 'unreadable': (state / 'open-notes.json').chmod(0)
        (state / 'ai-edits.json').write_text('existing marks')
        before = {p.name: p.read_bytes() for p in state.iterdir() if p.name != 'open-notes.json'}
        request(name)
        inode = (team / name).stat().st_ino
        upload()
        copy = team / (mode + ' (빌 수정).md')
        check((team / name).read_bytes() == b'original' and (team / name).stat().st_ino == inode, mode + ' original bytes/inode untouched')
        check(copy.read_bytes() == b'edited' and copy.stat().st_mode & 0o777 == 0o600, mode + ' exact copy/permissions')
        check(not list(out.iterdir()), mode + ' consumes queue immediately')
        check({p.name: p.read_bytes() for p in state.iterdir() if p.name != 'open-notes.json'} == before, mode + ' no proposal/marks/backup')
        upload()
        check(not (team / (mode + ' (빌 수정) 2.md')).exists(), mode + ' no repeated copy')
        if (state / 'open-notes.json').exists(): (state / 'open-notes.json').chmod(0o600)

    request('collision.md')
    (team / 'collision (빌 수정).md').write_bytes(b'older copy')
    upload()
    check((team / 'collision.md').read_bytes() == b'original', 'collision original untouched')
    check((team / 'collision (빌 수정).md').read_bytes() == b'older copy', 'existing copy untouched')
    check((team / 'collision (빌 수정) 2.md').read_bytes() == b'edited', 'collision suffix 2')
    request('deleted.md'); (team / 'deleted.md').unlink(); upload()
    check(not (team / 'deleted.md').exists() and (team / 'deleted (빌 수정).md').read_bytes() == b'edited', 'missing original does not get recreated')
    request('unreadable.md'); (team / 'unreadable.md').chmod(0); upload()
    (team / 'unreadable.md').chmod(0o600)
    check((team / 'unreadable.md').read_bytes() == b'original' and (team / 'unreadable (빌 수정) 2.md').read_bytes() == b'edited', 'unreadable original returns immediately')
    request('empty.md', edited=b''); upload()
    check((team / 'empty.md').read_bytes() == b'original' and (team / 'empty (빌 수정).md').read_bytes() == b'', 'empty return creates empty copy')
    request('crlf.md', original=b'original\r\n', edited=b'edited\r\n'); upload()
    check((team / 'crlf.md').read_bytes() == b'original\r\n' and (team / 'crlf (빌 수정).md').read_bytes() == b'edited\r\n', 'no newline conversion')
    name = unicodedata.normalize('NFD', '한글.md')
    request(name); upload()
    check((team / '한글 (빌 수정).md').read_bytes() == b'edited', 'NFD name preserved')

    # A queued old request carries a baseline, but it still cannot merge the original.
    request('legacy.md', original=b'changed')
    meta = next(out.glob('*.json')); item = json.loads(meta.read_text())
    baseline = out / meta.name.replace('.json', '.base')
    baseline.write_bytes(b'original'); item.update(base=h(b'original'), basePayload=True)
    meta.write_text(json.dumps(item)); upload()
    check((team / 'legacy.md').read_bytes() == b'changed' and (team / 'legacy (빌 수정).md').read_bytes() == b'edited', 'legacy baseline never merges')
    check(not list(out.iterdir()), 'legacy baseline consumed')

    request('same-current.md')
    meta = next(out.glob('*.json')); item = json.loads(meta.read_text())
    next(out.glob('*.data')).write_bytes(b'original'); item['sha256'] = h(b'original')
    meta.write_text(json.dumps(item)); upload()
    check((team / 'same-current.md').read_bytes() == b'original' and (team / 'same-current (빌 수정).md').read_bytes() == b'original', 'queued request always copies even when original matches')

    for unsafe in ['hash', 'member', 'file', 'symlink', 'hardlink', 'non-utf8']:
        request(unsafe + '.md')
        meta = next(out.glob('*.json')); item = json.loads(meta.read_text())
        payload = next(out.glob('*.data'))
        if unsafe == 'hash': item['sha256'] = '0' * 64
        if unsafe == 'member': item['member'] = '../bad'
        if unsafe == 'file': item['file'] = '../bad.md'
        if unsafe in ['symlink', 'hardlink']:
            payload.unlink(); victim = home / 'victim'; victim.write_bytes(b'edited')
            if unsafe == 'symlink': payload.symlink_to(victim)
            else: os.link(victim, payload)
        if unsafe == 'non-utf8': payload.write_bytes(b'\xff'); item['sha256'] = h(b'\xff')
        meta.write_text(json.dumps(item)); upload(False)
        check(meta.exists() and payload.exists(), unsafe + ' keeps request')
        check(not (team / (unsafe + ' (빌 수정).md')).exists(), unsafe + ' makes no copy')
        for p in out.iterdir(): p.unlink()

    request('retry.md'); team.chmod(0o500); upload(False); team.chmod(0o700)
    check(len(list(out.iterdir())) == 2, 'copy write failure retains request/payload')
    upload(); upload()
    check((team / 'retry (빌 수정).md').read_bytes() == b'edited' and not (team / 'retry (빌 수정) 2.md').exists(), 'retry creates exactly one copy')

    (shared / 'noop.md').write_bytes(b'original')
    (shared / '.manifest.json').write_text(json.dumps({'noop.md': {'base': h(b'original'), 'source': h(b'newer')}}))
    subprocess.run([sys.executable, producer, 'noop.md', '--as', '빌'], env=env, check=True, stdout=subprocess.DEVNULL)
    check(not list(out.iterdir()), 'unchanged copy queues nothing')
    for bad in ['../x', '.hidden', 'a/b', '1234567890123456789012345']:
        result = subprocess.run([sys.executable, producer, 'noop.md', '--as', bad], env=env, capture_output=True)
        check(result.returncode != 0, 'bad member rejected ' + bad)

print(f'PASS: {checks} helper return checks')
