#!/usr/bin/env python3
"""Run the production copy loop on a paced FIFO, substituting only its stat metadata."""
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time

root = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory() as tmp:
    home = Path(tmp).resolve()
    build = home / 'build'
    build.mkdir()
    for source in (root / 'Sources').glob('*.swift'):
        body = source.read_text()
        if source.name == 'Inbox.swift':
            body = body.replace('fstat(source, &sourceStat)', 'testSourceStat(source, &sourceStat)')
            body += '''
// Test fixture only: exercise the unchanged read/write loop with a real FIFO.
func testSourceStat(_ fd: Int32, _ info: UnsafeMutablePointer<stat>) -> Int32 {
    let result = Darwin.fstat(fd, info)
    if result == 0 && (info.pointee.st_mode & S_IFMT) == S_IFIFO {
        info.pointee.st_mode = (info.pointee.st_mode & ~S_IFMT) | S_IFREG
        info.pointee.st_size = 64
    }
    return result
}
'''
        (build / source.name).write_text(body)
    binary = build / 'helper'
    subprocess.run(['swiftc', '-D', 'STENO_HELPER_TESTING',
                    *map(str, build.glob('*.swift')), '-o', str(binary)], check=True)
    source, destination = home / 'out', home / 'in'
    source.mkdir()
    destination.mkdir()
    env = dict(os.environ)
    env.pop('STENO_HELPER_TEST_ALARM', None)
    chunks = [b'first\n', b'second\n', b'third\n', b'last\n']
    for enabled in (True, False):
        fifo = source / 'paced.md'
        os.mkfifo(fifo)
        errors = []
        def produce():
            try:
                with fifo.open('wb', buffering=0) as stream:
                    for chunk in chunks:
                        stream.write(chunk)
                        time.sleep(1)
            except Exception as error:
                errors.append(error)
        writer = threading.Thread(target=produce, daemon=True)
        writer.start()
        run_env = dict(env)
        if enabled:
            run_env['STENO_HELPER_TEST_ALARM'] = '2'
        start = time.monotonic()
        result = subprocess.run([str(binary), '--inbox', str(source), str(destination)],
                                env=run_env, capture_output=True, timeout=10)
        writer.join(timeout=2)
        assert result.returncode == 0, result.stderr
        assert not writer.is_alive() and not errors, errors
        assert time.monotonic() - start > 2
        assert (destination / 'paced.md').read_bytes() == b''.join(chunks)
        assert not fifo.exists()
        assert not list(destination.glob('.*.steno-part'))
        (destination / 'paced.md').unlink()

    # Initial bytes make progress, then the open writer holds the reader at read().
    fifo = source / 'stalled.md'
    os.mkfifo(fifo)
    holder = os.open(fifo, os.O_RDWR)
    try:
        os.write(holder, b'partial')
        start = time.monotonic()
        result = subprocess.run([str(binary), '--inbox', str(source), str(destination)],
                                env=dict(env, STENO_HELPER_TEST_ALARM='1'),
                                capture_output=True, timeout=5)
        elapsed = time.monotonic() - start
        assert result.returncode == 1, result.stderr
        assert '진척 없이 제한 시간을 넘겨 중단함'.encode() in result.stderr, result.stderr
        assert 0.8 <= elapsed < 3, elapsed
        assert not (destination / 'stalled.md').exists()
    finally:
        os.close(holder)
    print('PASS: 3 progress watchdog checks (paced copy, disabled alarm, stalled read without final file)')
