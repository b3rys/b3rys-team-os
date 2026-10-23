#!/usr/bin/env python3
"""Run the real producer and helper for both delivery destinations."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

binary = os.environ['STENO_HELPER_TEST_BIN']
send = Path(__file__).resolve().parents[2] / 'skills/b3os-team-inbox/scripts/steno-send.sh'
checks = 0
with tempfile.TemporaryDirectory() as tmp:
    home = Path(tmp).resolve()
    env = dict(os.environ, HOME=str(home))
    input_file = home / 'input.md'
    for mode in ('--inbox', '--upload'):
        library = home / mode[2:]
        dest = library / ('받은 파일' if mode == '--inbox' else '팀 공유')
        dest.mkdir(parents=True)
        if mode == '--upload':
            (dest / '.steno-folder').write_text('team')
        box = home / 'Library/Application Support/b3os' / ('steno-outbox' if mode == '--inbox' else 'steno-share-outbox')
        flags = ['--to-received'] if mode == '--inbox' else []
        def queue(data, name='note.md', folder='A/B', replace=True):
            input_file.write_text(data)
            args = [str(send), str(input_file), '--name', name, *flags]
            if folder:
                args += ['--folder', folder]
            if replace:
                args += ['--replace']
            return subprocess.run(args, env=env, capture_output=True, timeout=10)
        def consume(ok=True, edit=None):
            e = dict(env)
            if edit is not None:
                e['STENO_REPLACE_TEST_EDIT'] = edit
            result = subprocess.run([binary, mode, str(box), str(dest if mode == '--inbox' else library)], env=e, capture_output=True, timeout=10)
            assert result.returncode == (0 if ok else 1), result.stderr
            return result.stderr.decode()
        def discard():
            for f in box.glob('.steno-replace-*'):
                f.unlink()
        target = dest / 'A/B/note.md'
        # A normal send establishes ownership; replacement keeps its exact name.
        assert queue('v1', replace=False).returncode == 0
        consume()
        assert queue('v2').returncode == 0
        consume()
        assert target.read_text() == 'v2'
        assert not target.with_name('note 2.md').exists()
        previous = list((target.parent / '.steno/helper-replaced').glob('*/note.md'))
        assert [f.read_text() for f in previous] == ['v1']
        assert previous[0].stat().st_mode & 0o777 == 0o600
        # Restoring the retained bytes produces the original content.
        restored = home / 'restored.md'
        restored.write_bytes(previous[0].read_bytes())
        assert restored.read_text() == 'v1'
        receipts = list((target.parent / '.steno/helper-sent').glob('*.json'))
        assert json.loads(receipts[0].read_text())['file'] == 'note.md'
        checks += 4
        target.write_text('user edit')
        assert queue('v3').returncode == 0
        assert '사용자 편집' in consume(False)
        assert target.read_text() == 'user edit'
        assert list(box.glob('*.json'))
        discard(); checks += 1
        unknown = dest / 'unknown.md'
        unknown.write_text('user file')
        assert queue('overwrite', 'unknown.md', '').returncode == 0
        assert '보낸 기록이 없는' in consume(False)
        assert unknown.read_text() == 'user file'
        discard(); checks += 1
        # Missing target is created, then replace again (root destination).
        assert queue('new', 'fresh.md', '').returncode == 0
        consume()
        assert queue('next', 'fresh.md', '').returncode == 0
        consume()
        assert (dest / 'fresh.md').read_text() == 'next'
        checks += 1
        # Edit after hash validation, before publication: preserve edit.
        assert queue('race', 'fresh.md', '').returncode == 0
        assert '교체 직전 대상 변경' in consume(False, edit='late user edit')
        assert (dest / 'fresh.md').read_text() == 'late user edit'
        discard(); checks += 1
        # Never follow linked destination files/folders or hardlinks.
        victim = home / 'victim.md'; victim.write_text('safe')
        (dest / 'linked.md').symlink_to(victim)
        assert queue('overwrite', 'linked.md', '').returncode == 0
        consume(False)
        assert victim.read_text() == 'safe' and (dest / 'linked.md').is_symlink()
        discard(); checks += 1
        os.link(dest / 'fresh.md', dest / 'hard.md')
        assert queue('overwrite', 'fresh.md', '').returncode == 0
        consume(False)
        assert (dest / 'fresh.md').read_text() == 'late user edit'
        discard(); checks += 1
        (dest / 'linked-folder').symlink_to(home, target_is_directory=True)
        assert queue('outside', 'outside.md', 'linked-folder').returncode == 0
        consume(False)
        assert not (home / 'outside.md').exists()
        discard(); checks += 1
        # Malformed and forged requests must pass the helper's own validation.
        for bad in ('../escape.md', 'A/B/C/deep.md', 'api-token.md', 'A/password.md'):
            assert queue('payload', 'bad.md', '').returncode == 0
            request_file = next(box.glob('.steno-replace-*.json'))
            request = json.loads(request_file.read_text()); request['file'] = bad
            request_file.write_text(json.dumps(request))
            consume(False); discard(); checks += 1
        for name in ('api-token.md', '.env', 'my-password.md'):
            assert queue('secret', name, '').returncode == 1
            checks += 1
        # A corrupt payload never reaches the destination.
        assert queue('new bytes', 'fresh.md', '').returncode == 0
        next(box.glob('.steno-replace-*.data')).write_text('tampered')
        assert '본문·해시 거절' in consume(False)
        assert (dest / 'fresh.md').read_text() == 'late user edit'
        discard(); checks += 1
        # If history cannot be stored safely, keep the original untouched.
        assert queue('prior', 'history.md', 'history').returncode == 0
        consume()
        (dest / 'history/.steno/helper-replaced').symlink_to(home, target_is_directory=True)
        assert queue('next', 'history.md', 'history').returncode == 0
        consume(False)
        assert (dest / 'history/history.md').read_text() == 'prior'
        discard(); checks += 1
        # A linked receipt directory cannot authorize a replacement.
        assert queue('valid', 'state.md', 'state').returncode == 0
        consume()
        state = dest / 'state/.steno/helper-sent'
        state.rename(state.with_name('saved-receipts'))
        state.symlink_to(state.with_name('saved-receipts'), target_is_directory=True)
        assert queue('blocked', 'state.md', 'state').returncode == 0
        consume(False)
        assert (dest / 'state/state.md').read_text() == 'valid'
        discard(); checks += 1
print(f'PASS: {checks} safe replacement checks (inbox + team share)')
