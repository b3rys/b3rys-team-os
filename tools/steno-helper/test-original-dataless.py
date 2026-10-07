#!/usr/bin/env python3
"""Exercise return hydration/retry with real temporary files and injected dataless metadata."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid
import unicodedata

root = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory() as tmp:
    home = Path(tmp).resolve()
    sources = home / 'Sources'; sources.mkdir()
    for path in (root / 'Sources').glob('*.swift'):
        text = path.read_text()
        if path.name == 'UploadFileIO.swift':
            text = text.replace('fstatat(dir, name, &info, AT_SYMLINK_NOFOLLOW)', 'testFstatat(dir, name, &info, AT_SYMLINK_NOFOLLOW)')
            text += '''
func testFstatat(_ dir: Int32, _ name: String, _ info: UnsafeMutablePointer<stat>, _ options: Int32) -> Int32 {
    let result = Darwin.fstatat(dir, name, info, options)
    if result == 0 && name == ProcessInfo.processInfo.environment["TEST_DATALESS_NAME"] {
        info.pointee.st_flags |= UInt32(SF_DATALESS)
    }
    return result
}
'''
        if path.name == 'Share.swift':
            start = text.index('func requestSourceDownload(')
            end = text.index('\nprivate func sha256', start)
            text = text[:start] + '''func requestSourceDownload(_ url: URL) {
    try! Data(url.path.utf8).write(to: URL(fileURLWithPath: ProcessInfo.processInfo.environment["HOME"]!).appendingPathComponent("download.txt"))
}
''' + text[end:]
        (sources / path.name).write_text(text)
    fix = (sources / 'ShareReturn.swift').read_text()
    begin = fix.index('    guard let original = uploadReadRegular(destination, request.file) else {')
    end = fix.index('    guard let originalInfo', begin)
    mutant = fix[:begin] + '    guard let original = uploadReadRegular(destination, request.file) else { return .copy }\n' + fix[end:]
    for variant, body in [('baseline', fix), ('mutant', mutant)]:
        (sources / 'ShareReturn.swift').write_text(body)
        binary = home / variant
        subprocess.run(['swiftc', '-D', 'STENO_HELPER_TESTING', *map(str, sources.glob('*.swift')), '-o', str(binary)], check=True, capture_output=True)
        fixture = home / (variant + '-home'); fixture.mkdir()
        library = fixture / 'notes'; team = library / '팀 공유'; team.mkdir(parents=True)
        (team / '.steno-folder').write_text('team')
        state = library / '.steno'; state.mkdir()
        out = fixture / 'out'; out.mkdir()
        name = 'hydration.md'; original = b'a\nb'; proposed = b'a\nB'
        (team / name).write_bytes(b'A\nb')
        identifier = str(uuid.uuid4()); stem = '.return-' + identifier
        digest = lambda data: hashlib.sha256(data).hexdigest()
        (out / (stem + '.json')).write_text(json.dumps({'file': name, 'member': '빌', 'base': digest(original), 'basePayload': True, 'sha256': digest(proposed)}))
        (out / (stem + '.data')).write_bytes(proposed); (out / (stem + '.base')).write_bytes(original)
        pending = out / (stem + '.pending'); copy = team / 'hydration (빌 수정).md'
        env = dict(os.environ, HOME=str(fixture))
        def cycle(dataless=False):
            subprocess.run([str(binary), '--upload', str(out), str(library)], env=dict(env, TEST_DATALESS_NAME=name if dataless else ''), check=True, capture_output=True)
        cycle(True)
        waiting = not copy.exists() and pending.exists() and (out / (stem + '.json')).exists() and (out / (stem + '.data')).read_bytes() == proposed
        if variant == 'mutant':
            assert not waiting, 'original-read fallback mutant was not caught'
            print('EXPECTED FAIL: immediate-copy fallback restored')
            continue
        assert waiting, 'dataless original must retain return and pending without copy'
        assert unicodedata.normalize('NFC', (fixture / 'download.txt').read_text()) == str(team / name), 'download must target original'
        stamp = json.loads(pending.read_text())['createdAt']
        cycle(True)
        assert json.loads(pending.read_text())['createdAt'] == stamp, 'retry must not reset first attempt'
        # Unknown/open state proceeds through the existing proposal protocol after hydration.
        (state / 'open-notes.json').write_text('broken')
        cycle()
        item = json.loads(pending.read_text())
        assert item['createdAt'] == stamp and item['base'] == 'a\nb' and item['proposed'] == 'a\nB'
        proposals = state / 'mcp-proposals'
        assert (proposals / (identifier + '.json')).exists() and not copy.exists()
        (proposals / (identifier + '.reply.json')).write_text(json.dumps({'status': 'notOpen'}))
        cycle()
        assert (team / name).read_bytes() == b'A\nB' and not list(out.iterdir()) and not copy.exists(), 'hydrated original merges and consumes return'
        # A still-unreadable original uses the same five-minute fallback.
        (out / (stem + '.json')).write_text(json.dumps({'file': name, 'member': '빌', 'base': digest(original), 'basePayload': True, 'sha256': digest(proposed)}))
        (out / (stem + '.data')).write_bytes(proposed); (out / (stem + '.base')).write_bytes(original)
        cycle(True)
        pending.write_text(json.dumps({'createdAt': '2026-01-01T00:00:00Z'}))
        cycle(True)
        assert copy.read_bytes() == proposed and not list(out.iterdir()), 'unreadable original falls back only after first-attempt timeout'
        print('PASS: 1 original dataless → pending/retry → proposal → merge regression (first timestamp preserved)')
