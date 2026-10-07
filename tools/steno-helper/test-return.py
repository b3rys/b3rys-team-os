#!/usr/bin/env python3
"""Return requests through the real producer/helper, using temporary libraries only."""
import datetime
import hashlib
import json
import os
import socket
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
    env = dict(os.environ, HOME=str(home), STENO_SHARE_NO_KICK='1')
    env.pop('STENO_SHARE_TEST_REFRESH', None)

    def write_record(value):
        temporary = state / 'open-record.tmp'
        temporary.write_text(value)
        temporary.replace(state / 'open-notes.json')

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
        time.sleep(0.05)
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
    record = {'host': socket.gethostname(), 'pid': os.getpid(), 'processStart': epoch, 'updatedAt': '2026-10-07T00:00:00Z',
              'held': [str(team / 'held.md')], 'current': str(team / 'held.md')}
    write_record(json.dumps(record))
    received = []
    def reply_once(status='applied', before_reply=None):
        folder = state / 'mcp-proposals'
        for _ in range(100):
            files = list(folder.glob('*.json')) if folder.exists() else []
            files = [p for p in files if not p.name.endswith('.reply.json')]
            if files:
                item = json.loads(files[0].read_text()); received.append(item)
                if before_reply: before_reply()
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

    request('held.md'); shared.chmod(0o500)
    thread = threading.Thread(target=reply_once); thread.start()
    upload(); thread.join(); shared.chmod(0o700)
    result = subprocess.CompletedProcess([], 0)
    check(result.returncode == 0 and not list(out.iterdir()), 'applied is terminal even if team receipt fails')
    upload()
    check(not list((state / 'mcp-proposals').iterdir()) and not (team / 'held (빌 수정).md').exists(), 'applied receipt failure is never replayed')

    request('held.md')
    result = subprocess.run([binary, '--upload', str(out), str(lib)], env=env)
    check(result.returncode == 0, 'held timeout safely finishes')
    check(not (team / 'held (빌 수정).md').exists() and list(out.glob('*.pending')), 'no reply retains queue without immediate copy')
    pending = next(out.glob('*.pending'))
    item = json.loads(pending.read_text()); first_id = item['id']
    upload()
    check(json.loads(pending.read_text())['id'] == first_id and len(list((state / 'mcp-proposals').glob('*.json'))) == 1, 'next cycle reuses one proposal UUID')
    item['createdAt'] = '2026-01-01T00:00:00Z'; pending.write_text(json.dumps(item))
    upload()
    check((team / 'held (빌 수정).md').read_bytes() == b'edited', 'five-minute timeout alone produces copy')
    check((team / 'held.md').read_bytes() == b'original', 'held timeout preserves original')

    for status in ['stale', 'refused', 'saveFailed']:
        name = status + '.md'
        record['held'] = [str(team / name)]; record['current'] = str(team / name)
        write_record(json.dumps(record))
        request(name)
        thread = threading.Thread(target=lambda: reply_once(status)); thread.start(); upload(); thread.join()
        check((team / (status + ' (빌 수정).md')).read_bytes() == b'edited' and not list(out.iterdir()), status + ' makes one copy and consumes queue')
        upload()
        check(not (team / (status + ' (빌 수정) 2.md')).exists(), status + ' produces no duplicate on next pass')

    record['held'] = [str(team / 'not-open.md')]; record['current'] = record['held'][0]
    write_record(json.dumps(record))
    request('not-open.md', original=b'A\nb', edited=b'a\nB', baseline=b'a\nb')
    thread = threading.Thread(target=lambda: reply_once('notOpen')); thread.start(); upload(); thread.join()
    check((team / 'not-open.md').read_bytes() == b'A\nB' and not (team / 'not-open (빌 수정).md').exists(), 'notOpen takes closed merge path')

    request('not-open.md')
    def reopen():
        record['updatedAt'] = '2026-10-07T01:00:00Z'
        write_record(json.dumps(record))
    thread = threading.Thread(target=lambda: reply_once('notOpen', before_reply=reopen)); thread.start(); upload(); thread.join()
    check((team / 'not-open.md').read_bytes() == b'original' and (team / 'not-open (빌 수정).md').read_bytes() == b'edited', 'notOpen followed by new held record falls back without original write')

    record['held'] = [str(team / 'unknown-after-reply.md')]; record['current'] = record['held'][0]
    write_record(json.dumps(record)); request('unknown-after-reply.md')
    thread = threading.Thread(target=lambda: reply_once('notOpen', before_reply=lambda: write_record('broken')))
    thread.start(); upload(); thread.join()
    check((team / 'unknown-after-reply.md').read_bytes() == b'original' and (team / 'unknown-after-reply (빌 수정).md').exists(), 'notOpen followed by unknown state never writes original')

    write_record('broken')
    request('broken.md'); upload()
    check((team / 'broken.md').read_bytes() == b'original', 'unreadable state original untouched')
    check(not (team / 'broken (빌 수정).md').exists(), 'unreadable state queues proposal instead of copy')
    reply_once('notOpen'); upload()
    check((team / 'broken.md').read_bytes() == b'edited', 'app notOpen permits merge with unchanged unreadable state')

    remote = dict(record, host='other-mac', pid=2147483647, processStart=0,
                  held=['/Users/other/Library/Mobile Documents/Steno/팀 공유/remote.md'])
    write_record(json.dumps(remote)); request('remote.md')
    upload()
    pending = next(out.glob('*.pending')); item = json.loads(pending.read_text())
    check(item['path'] == str(team / 'remote.md'), 'remote proposal preserves existing format')
    check((team / 'remote.md').read_bytes() == b'original' and not (team / 'remote (빌 수정).md').exists(), 'remote PID is not checked on this Mac')
    reply_once(); upload()
    check(not list(out.iterdir()), 'late remote applied consumes pending return without copy')

    legacy = dict(record); legacy.pop('host')
    write_record(json.dumps(legacy)); request('legacy.md'); upload()
    check((team / 'legacy.md').read_bytes() == b'original' and list(out.glob('*.pending')), 'hostless record cannot authorize a local write')
    reply_once('notOpen'); upload()
    record['held'] = []; record['current'] = None
    write_record(json.dumps(record))
    request('closed.md'); upload()
    check((team / 'closed.md').read_bytes() == b'edited', 'live record without held note permits replacement')
    request('deleted.md'); (team / 'deleted.md').unlink(); upload()
    check((team / 'deleted (빌 수정).md').read_bytes() == b'edited' and not list(out.iterdir()), 'deleted original makes copy and consumes queue')

    (state / 'ai-edits.json').write_text('broken')
    request('bad-marks.md')
    result = subprocess.run([binary, '--upload', str(out), str(lib)], env=env)
    check(result.returncode == 0 and (team / 'bad-marks (빌 수정).md').read_bytes() == b'edited', 'malformed marks makes fallback copy')
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
    check(result.returncode == 0 and (team / 'marks-permission (빌 수정).md').read_bytes() == b'edited' and not list(out.iterdir()), 'write failure makes one copy and consumes queue')
    upload()
    check(not (team / 'marks-permission (빌 수정) 2.md').exists(), 'write failure is terminal, no duplicate copy')

    request('crlf.md', original=b'A\r\nb\r\n', edited=b'a\nB\n', baseline=b'a\r\nb\r\n'); upload()
    check((team / 'crlf.md').read_bytes() == b'A\r\nB\r\n', 'closed merge preserves CRLF')
    before_backups = list((state / 'trash').iterdir())
    before_marks = (state / 'ai-edits.json').read_bytes()
    request('same-current.md', original=b'edited', edited=b'edited'); upload()
    check(list((state / 'trash').iterdir()) == before_backups and (state / 'ai-edits.json').read_bytes() == before_marks, 'merge equal to current makes no backup or mark')

    (shared / 'noop.md').write_bytes(b'original')
    (shared / '.manifest.json').write_text(json.dumps({'noop.md': {'base': h(b'original'), 'source': h(b'newer')}}))
    subprocess.run([sys.executable, producer, 'noop.md', '--as', '빌'], env=env, check=True, stdout=subprocess.DEVNULL)
    check(not list(out.iterdir()), 'unchanged copy queues nothing')
    for bad in ['../x', '.hidden', 'a/b', '1234567890123456789012345']:
        result = subprocess.run([sys.executable, producer, 'noop.md', '--as', bad], env=env, capture_output=True)
        check(result.returncode != 0, 'bad member rejected ' + bad)

print(f'PASS: {checks} helper return checks')
