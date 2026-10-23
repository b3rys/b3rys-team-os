#!/usr/bin/env python3
"""A separate process saves after the last check and while the old inode is retained."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

binary = os.environ['STENO_HELPER_TEST_BIN']
send = Path(__file__).resolve().parents[2] / 'skills/b3os-team-inbox/scripts/steno-send.sh'
checks = 0
with tempfile.TemporaryDirectory() as tmp:
    home = Path(tmp).resolve()
    for mode in ('--inbox', '--upload'):
        for scenario in ('in-place', 'atomic-save', 'open-descriptor', 'rollback-save'):
            workspace = home / (mode[2:] + '-' + scenario)
            dest = workspace / 'notes' / ('받은 파일' if mode == '--inbox' else '팀 공유')
            dest.mkdir(parents=True)
            if mode == '--upload':
                (dest / '.steno-folder').write_text('team')
            env = dict(os.environ, HOME=str(workspace))
            source = workspace / 'input.md'
            flags = ['--to-received'] if mode == '--inbox' else []
            box = workspace / 'Library/Application Support/b3os' / ('steno-outbox' if mode == '--inbox' else 'steno-share-outbox')
            args = [binary, mode, str(box), str(dest if mode == '--inbox' else dest.parent)]
            def queue(text, replace):
                source.write_text(text)
                subprocess.run([str(send), str(source), '--name', 'race.md', *flags,
                                *(['--replace'] if replace else [])], env=env, capture_output=True, check=True)
            queue('v1', False)
            first = subprocess.run(args, env=env, capture_output=True)
            assert first.returncode == 0, (args, first.stderr)
            target = dest / 'race.md'
            prior_inode = target.stat().st_ino
            queue('v2', True)
            stages = 'after-swap' if scenario == 'open-descriptor' else 'before-swap'
            if scenario == 'rollback-save':
                stages += ',before-rollback'
            marker = workspace / 'paused'
            child = subprocess.Popen(args, env=dict(env, STENO_REPLACE_TEST_PAUSE=stages,
                                     STENO_REPLACE_TEST_MARKER=str(marker)), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            def wait_at(stage):
                path = Path(str(marker) + '-' + stage)
                deadline = time.monotonic() + 10
                while not path.exists():
                    assert child.poll() is None, 'helper exited before ' + stage
                    assert time.monotonic() < deadline, 'probe timeout: ' + stage
                    time.sleep(.005)
                # The marker is written immediately before SIGSTOP; wait until
                # stopped so SIGCONT cannot race ahead of the stop itself.
                pid, status = os.waitpid(child.pid, os.WUNTRACED)
                assert pid == child.pid and os.WIFSTOPPED(status)
            opened = None
            try:
                if scenario == 'open-descriptor':
                    opened = target.open('r+')
                wait_at(stages.split(',')[0])
                if scenario == 'atomic-save':
                    temp = target.with_suffix('.new')
                    temp.write_text('user edit after final check')
                    temp.replace(target)
                elif scenario == 'open-descriptor':
                    # The old fd now refers to the inode retained in history.
                    opened.seek(0); opened.write('user edit through open descriptor'); opened.truncate()
                    opened.flush(); os.fsync(opened.fileno())
                else:
                    target.write_text('user edit after final check')
                    assert target.stat().st_ino == prior_inode
                os.kill(child.pid, signal.SIGCONT)
                if scenario == 'rollback-save':
                    wait_at('before-rollback')
                    target.write_text('second edit before rollback')
                    os.kill(child.pid, signal.SIGCONT)
                stdout, stderr = child.communicate(timeout=10)
                assert child.returncode == 1, stderr
                assert '맞바꾸기 중 사용자 편집 감지'.encode() in stderr, stderr
                expected = 'user edit through open descriptor' if scenario == 'open-descriptor' else 'user edit after final check'
                assert target.read_text() == expected
                if scenario != 'atomic-save':
                    assert target.stat().st_ino == prior_inode
                history = list((dest / '.steno/helper-replaced').glob('*/race.md'))
                assert len(history) == 1
                assert history[0].read_text() == ('second edit before rollback' if scenario == 'rollback-save' else 'v2')
                assert list(box.glob('.steno-replace-*.json')), 'rejected request must remain queued'
                receipt = dest / '.steno/helper-sent' / (hashlib.sha256(b'race.md').hexdigest() + '.json')
                assert json.loads(receipt.read_text())['sha256'] == hashlib.sha256(b'v1').hexdigest()
                checks += 1
                print(f'PASS {mode} {scenario}: edit preserved, replacement rejected')
            finally:
                if opened:
                    opened.close()
                if child.poll() is None:
                    child.kill(); child.wait()
        # A descriptor kept open beyond a successful replacement must still
        # write into a retained inode, rather than an unlinked temporary file.
        workspace = home / (mode[2:] + '-retained-descriptor')
        dest = workspace / 'notes' / ('받은 파일' if mode == '--inbox' else '팀 공유')
        dest.mkdir(parents=True)
        if mode == '--upload':
            (dest / '.steno-folder').write_text('team')
        env = dict(os.environ, HOME=str(workspace))
        source = workspace / 'input.md'
        flags = ['--to-received'] if mode == '--inbox' else []
        box = workspace / 'Library/Application Support/b3os' / ('steno-outbox' if mode == '--inbox' else 'steno-share-outbox')
        args = [binary, mode, str(box), str(dest if mode == '--inbox' else dest.parent)]
        source.write_text('v1')
        subprocess.run([str(send), str(source), '--name', 'retained.md', *flags], env=env, capture_output=True, check=True)
        subprocess.run(args, env=env, capture_output=True, check=True)
        target = dest / 'retained.md'
        old_inode = target.stat().st_ino
        with target.open('r+') as opened:
            source.write_text('v2')
            subprocess.run([str(send), str(source), '--name', 'retained.md', *flags, '--replace'], env=env, capture_output=True, check=True)
            subprocess.run(args, env=env, capture_output=True, check=True)
            history = list((dest / '.steno/helper-replaced').glob('*/retained.md'))
            assert len(history) == 1 and history[0].stat().st_ino == old_inode
            opened.seek(0); opened.write('saved after helper finished'); opened.truncate()
            opened.flush(); os.fsync(opened.fileno())
        assert history[0].read_text() == 'saved after helper finished'
        assert target.read_text() == 'v2'
        checks += 1
        print(f'PASS {mode} retained-descriptor: later save preserved in history')
print(f'PASS: {checks} concurrent-save replacement checks')
