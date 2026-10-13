#!/usr/bin/env python3
"""Exercise cleanup, failed partial writes, and the cycle watchdog in temporary HOME."""
import os
import pathlib
import resource
import signal
import subprocess
import tempfile

binary = os.environ['STENO_HELPER_TEST_BIN']
checks = 0
with tempfile.TemporaryDirectory() as temp:
    home = pathlib.Path(temp).resolve()
    library = home / 'Documents/Steno'
    support = home / 'Library/Application Support/b3os'
    inbox = library / '받은 파일'
    team = library / '팀 공유'
    outbox = support / 'steno-outbox'
    upload = support / 'steno-share-outbox'
    shared = support / 'steno-shared'
    bases = shared / '.bases'
    for directory in (inbox, team, outbox, upload, shared, bases):
        directory.mkdir(parents=True, exist_ok=True)
    (team / '.steno-folder').write_text('team')
    env = dict(os.environ, HOME=str(home), STENO_LIBRARY=str(library))
    env.pop('STENO_HELPER_TEST_ALARM', None)
    destinations = (inbox, team, shared, bases)
    for directory in destinations:
        (directory / '.stale.steno-part').write_text('partial')
        (directory / '.link.steno-part').symlink_to(home / 'victim')
        (directory / '.folder.steno-part').mkdir()
    (home / 'victim').write_text('untouched')
    for directory in (outbox, upload):
        (directory / '.ignored.steno-part').write_text('partial')
    (outbox / 'received.md').write_text('received')
    (upload / 'uploaded.md').write_text('uploaded')
    result = subprocess.run([binary, '--cycle', str(home)], env=env, capture_output=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert '앱 기록'.encode() not in result.stderr, result.stderr
    for directory in destinations:
        assert not (directory / '.stale.steno-part').exists()
        assert (directory / '.link.steno-part').is_symlink()
        assert (directory / '.folder.steno-part').is_dir()
    assert (home / 'victim').read_text() == 'untouched'
    assert (inbox / 'received.md').read_text() == 'received'
    assert (team / 'uploaded.md').read_text() == 'uploaded'
    assert (shared / 'uploaded.md').read_text() == 'uploaded'
    assert not (shared / '.ignored.steno-part').exists()
    checks += 1

    # Missing record in an existing parent is also a normal, silent fallback.
    record_parent = home / 'Library/Application Support/Steno'
    record_parent.mkdir()
    result = subprocess.run([binary, '--resolve', str(home)], env=env, capture_output=True, timeout=10)
    assert result.returncode == 0 and result.stdout.strip() == str(library).encode(), result
    assert '앱 기록'.encode() not in result.stderr, result.stderr
    checks += 1

    # Limit writes to 1 KiB: the first write is partial, the next fails with EFBIG.
    # Ignoring SIGXFSZ lets the helper exercise its normal failure cleanup.
    def limit_writes():
        signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
        resource.setrlimit(resource.RLIMIT_FSIZE, (1024, 1024))

    for mode, source, destination in (
        ('--inbox', outbox, inbox),
        ('--upload', upload, library),
        ('--share', team, shared),
    ):
        name = 'failed-' + mode[2:] + '.md'
        (source / name).write_bytes(b'x' * 4096)
        result = subprocess.run([binary, mode, str(source), str(destination)], env=env,
                                preexec_fn=limit_writes, capture_output=True, timeout=10)
        assert result.returncode == 1, (mode, result.stderr)
        actual_destination = team if mode == '--upload' else destination
        assert not (actual_destination / name).exists(), mode
        assert (source / name).read_bytes() == b'x' * 4096, mode
        assert not [p for p in actual_destination.glob('.*.steno-part') if p.is_file() and not p.is_symlink()], mode
        (source / name).unlink()
        checks += 1

    # A FIFO blocks inbox open before validation; the real handler must terminate it.
    fifo = outbox / 'slow.md'
    os.mkfifo(fifo)
    env['STENO_HELPER_TEST_ALARM'] = '1'
    result = subprocess.run([binary, '--cycle', str(home)], env=env, capture_output=True, timeout=5)
    assert result.returncode == 1, result
    assert '제한 시간을 넘겨 중단함'.encode() in result.stderr, result.stderr
    assert not (inbox / 'slow.md').exists()
    checks += 1

print(f'PASS: {checks} 원자적 저장·watchdog checks')
