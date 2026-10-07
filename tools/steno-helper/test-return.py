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
import threading
import time
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
    env = dict(os.environ, HOME=str(home), STENO_SHARE_NO_KICK='1', STENO_TEST_PROPOSAL_TIMEOUT='0.2')
    env.pop('STENO_SHARE_TEST_REFRESH', None)
    env.pop('STENO_TEST_APP_RUNNING', None)

    def request(name, original=b'original', edited=b'edited', source=None, base=None, baseline=b'original'):
        (team / name).write_bytes(original)
        (shared / name).write_bytes(edited)
        snapshots = shared / '.bases'; snapshots.mkdir(exist_ok=True)
        (snapshots / (h(baseline) + '.data')).write_bytes(baseline)
        manifest = {name: {'file': name, 'base': base or h(baseline), 'source': source or h(original)}}
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
    check((team / 'conflict.md').read_bytes() == b'edited', 'base mismatch merges original, proposed wins same line')
    check(not (team / 'conflict (빌 수정).md').exists(), 'base mismatch makes no copy')

    # A real live pid, not a mocked liveness result. ps reports start to whole seconds.
    start = subprocess.check_output(['ps', '-p', str(os.getpid()), '-o', 'lstart='], text=True).strip()
    epoch = datetime.datetime.strptime(start, '%a %b %d %H:%M:%S %Y').timestamp()
    record = {'pid': os.getpid(), 'processStart': epoch, 'updatedAt': '2026-10-07T00:00:00Z',
              'held': [str(team / 'held.md')], 'current': str(team / 'held.md')}
    (state / 'open-notes.json').write_text(json.dumps(record))
    received = []
    def reply_once(status='applied'):
        folder = state / 'mcp-proposals'
        for _ in range(100):
            files = list(folder.glob('*.json')) if folder.exists() else []
            files = [p for p in files if not p.name.endswith('.reply.json')]
            if files:
                item = json.loads(files[0].read_text()); received.append(item)
                temp = folder / 'reply.tmp'
                temp.write_text(json.dumps({'status': status}))
                temp.rename(folder / (item['id'] + '.reply.json'))
                return
            time.sleep(0.01)
        raise AssertionError('held proposal missing')
    notification_log = home / 'notification.log'
    observer = subprocess.Popen([binary, '--watch-proposal-log', str(notification_log)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for _ in range(100):
        if Path(str(notification_log) + '.ready').exists(): break
        time.sleep(0.01)
    check(Path(str(notification_log) + '.ready').exists(), 'real notification observer ready')
    request('held.md')
    thread = threading.Thread(target=reply_once); thread.start(); upload(); thread.join()
    _, error = observer.communicate(timeout=5)
    check(observer.returncode == 0 and received[-1]['id'] in notification_log.read_text().splitlines(), 'DistributedNotification carries proposal UUID')
    check((team / 'held.md').read_bytes() == b'original', 'held original only app owns writes')
    check(not (team / 'held (빌 수정).md').exists(), 'held applied does not produce copy')
    proposal = received[-1]
    check(proposal['path'] == str(team / 'held.md') and proposal['editor'] == '빌', 'MCPProposal path/editor')
    check(proposal['base'] == 'original' and proposal['proposed'] == 'edited' and uuid.UUID(proposal['id']), 'MCPProposal body/UUID')
    check(not list((state / 'mcp-proposals').iterdir()), 'proposal request/reply cleaned up')

    request('held.md')
    result = subprocess.run([binary, '--upload', str(out), str(lib)], env=env)
    check(result.returncode == 0, 'held timeout safely finishes')
    check((team / 'held (빌 수정).md').read_bytes() == b'edited', 'held timeout alone produces copy')
    check((team / 'held.md').read_bytes() == b'original', 'held timeout preserves original')

    request('held.md')
    thread = threading.Thread(target=lambda: reply_once('refused')); thread.start()
    result = subprocess.run([binary, '--upload', str(out), str(lib)], env=env); thread.join()
    check(result.returncode != 0, 'held refusal is visible failure')
    check(len(list(out.glob('.return-*.json'))) == 1, 'held refusal preserves queued request')
    check(not (team / 'held (빌 수정) 2.md').exists(), 'refusal never writes copy')
    for p in out.iterdir(): p.unlink()


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
    request('bad-marks.md')
    result = subprocess.run([binary, '--upload', str(out), str(lib)], env=env)
    check(result.returncode != 0, 'malformed marks visibly refused')
    check((team / 'bad-marks.md').read_bytes() == b'original', 'malformed marks never overwritten')
    check((state / 'ai-edits.json').read_text() == 'broken', 'existing malformed marks retained')
    for p in out.iterdir(): p.unlink()
    (state / 'ai-edits.json').write_text(json.dumps(marks))

    # Baseline hash is checked by helper, not trusted from manifest source.
    request('queued-race.md', original=b'a\nb', edited=b'a\nB', baseline=b'a\nb')
    (team / 'queued-race.md').write_bytes(b'A\nb')
    upload()
    check((team / 'queued-race.md').read_bytes() == b'A\nB', 'queued race preserves independent edit')
    check(not (team / 'queued-race (빌 수정).md').exists(), 'queued race merges without copy')
    request('empty.md', edited=b''); upload()
    check((team / 'empty.md').read_bytes() == b'', 'return can clear whole document')

    # Two successful rounds must not treat an already-submitted line as a new edit.
    (team / 'rounds.md').write_bytes(b'a\nb\nc')
    subprocess.run([binary, '--share', str(team), str(shared)], env=env, check=True)
    (shared / 'rounds.md').write_bytes(b'a\nB\nc')
    (team / 'rounds.md').write_bytes(b'A\nb\nc')
    subprocess.run([sys.executable, producer, 'rounds.md', '--as', '빌'], env=env, check=True, stdout=subprocess.DEVNULL)
    upload()
    subprocess.run([binary, '--share', str(team), str(shared)], env=env, check=True)
    check((shared / 'rounds.md').read_bytes() == b'A\nB\nc', 'accepted merge refreshes team copy')
    check(json.loads((shared / '.manifest.json').read_text())['rounds.md']['base'] == h(b'A\nB\nc'), 'accepted merge advances baseline')
    (team / 'rounds.md').write_bytes(b'A\nGD-new\nc')
    (shared / 'rounds.md').write_bytes(b'A\nB\nC')
    subprocess.run([sys.executable, producer, 'rounds.md', '--as', '빌'], env=env, check=True, stdout=subprocess.DEVNULL)
    upload()
    check((team / 'rounds.md').read_bytes() == b'A\nGD-new\nC', 'next return preserves GD-new untouched line')

    (team / 'inflight.md').write_bytes(b'a\nb\nc')
    subprocess.run([binary, '--share', str(team), str(shared)], env=env, check=True)
    (shared / 'inflight.md').write_bytes(b'a\nB\nc')
    (team / 'inflight.md').write_bytes(b'A\nb\nc')
    subprocess.run([sys.executable, producer, 'inflight.md', '--as', '빌'], env=env, check=True, stdout=subprocess.DEVNULL)
    (shared / 'inflight.md').write_bytes(b'a\nB\nC')  # New team input after submission.
    upload()
    subprocess.run([binary, '--share', str(team), str(shared)], env=env, check=True)
    check((shared / 'inflight.md').read_bytes() == b'a\nB\nC', 'accepted old return never overwrites newer team input')
    check(json.loads((shared / '.manifest.json').read_text())['inflight.md']['base'] == h(b'a\nB\nc'), 'new team input rebased on accepted submission')
    (team / 'inflight.md').write_bytes(b'A\nGD-new\nc')
    subprocess.run([sys.executable, producer, 'inflight.md', '--as', '빌'], env=env, check=True, stdout=subprocess.DEVNULL)
    upload()
    check((team / 'inflight.md').read_bytes() == b'A\nGD-new\nC', 'second inflight return preserves GD-new')

    request('marks-permission.md')
    state.chmod(0o500)
    result = subprocess.run([binary, '--upload', str(out), str(lib)], env=env)
    state.chmod(0o700)
    check(result.returncode != 0 and (team / 'marks-permission.md').read_bytes() == b'original', 'marks preparation failure precedes body write')
    upload()
    check((team / 'marks-permission.md').read_bytes() == b'edited' and '팀 공유/marks-permission.md' in json.loads((state / 'ai-edits.json').read_text()), 'permission retry commits body and marks together')

    request('marks-crash.md')
    result = subprocess.run([binary, '--upload', str(out), str(lib)], env=dict(env, STENO_TEST_FAIL_MARK_COMMIT='1'))
    check(result.returncode != 0 and (team / 'marks-crash.md').read_bytes() == b'edited', 'simulated interruption follows body commit')
    check(list((state / 'helper-return-journal').glob('*.json')), 'interrupted commit retains recovery journal')
    upload()
    check('팀 공유/marks-crash.md' in json.loads((state / 'ai-edits.json').read_text()), 'retry repairs marks rather than swallowing noop')
    check(not list((state / 'helper-return-journal').glob('*.json')), 'finished return removes recovery journal')

    (shared / 'noop.md').write_bytes(b'original')
    (shared / '.manifest.json').write_text(json.dumps({'noop.md': {'base': h(b'original'), 'source': h(b'newer')}}))
    subprocess.run([sys.executable, producer, 'noop.md', '--as', '빌'], env=env, check=True, stdout=subprocess.DEVNULL)
    check(not list(out.iterdir()), 'unchanged copy queues nothing')
    for bad in ['../x', '.hidden', 'a/b', '1234567890123456789012345']:
        result = subprocess.run([sys.executable, producer, 'noop.md', '--as', bad], env=env, capture_output=True)
        check(result.returncode != 0, 'bad member rejected ' + bad)

print(f'PASS: {checks} helper return checks')
