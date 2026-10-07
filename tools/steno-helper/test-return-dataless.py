#!/usr/bin/env python3
"""Compile production return code with only original-file stat metadata substituted."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import uuid

root = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory() as tmp:
    home = Path(tmp)
    for mutant in [False, True]:
        build = home / ('mutant' if mutant else 'baseline'); build.mkdir()
        for source in (root / 'Sources').glob('*.swift'):
            if source.name == 'main.swift': continue
            body = source.read_text()
            if source.name == 'UploadFileIO.swift': body = body.replace('fstatat(', 'testFstatat(')
            if mutant and source.name == 'ShareReturn.swift':
                assert '    let ns = request.file as NSString' in body
                body = body.replace('    let ns = request.file as NSString', '    _ = uploadReadRegular(destination, request.file)\n    let ns = request.file as NSString')
            (build / source.name).write_text(body)
        (build / 'main.swift').write_text('''import Darwin
import Foundation
var originalReads = 0
func testFstatat(_ dir: Int32, _ name: String, _ info: UnsafeMutablePointer<stat>, _ options: Int32) -> Int32 {
    let result = Darwin.fstatat(dir, name, info, options)
    if name == "dataless.md" {
        originalReads += 1
        if result == 0 { info.pointee.st_flags |= UInt32(SF_DATALESS) }
    }
    return result
}
let args = CommandLine.arguments
let result = runShareUpload(sourcePath: args[1], libraryPath: args[2])
precondition(originalReads == 0, "return must not inspect original even when dataless")
exit(result)
''')
        binary = build / 'helper'
        subprocess.run(['swiftc', *map(str, build.glob('*.swift')), '-o', str(binary)], check=True, capture_output=True)
        out = build / 'out'; out.mkdir()
        lib = build / 'lib'; team = lib / '팀 공유'; team.mkdir(parents=True)
        (team / '.steno-folder').write_text('team'); (team / 'dataless.md').write_bytes(b'original')
        identifier = str(uuid.uuid4()); stem = '.return-' + identifier
        (out / (stem + '.data')).write_bytes(b'edited')
        (out / (stem + '.json')).write_text(json.dumps({'file': 'dataless.md', 'member': '빌', 'sha256': hashlib.sha256(b'edited').hexdigest()}))
        result = subprocess.run([str(binary), str(out), str(lib)], capture_output=True, text=True)
        if mutant:
            assert result.returncode != 0 and 'must not inspect original' in result.stderr, result.stderr
            print('EXPECTED FAIL: original read reintroduced into return')
        else:
            assert result.returncode == 0, result.stderr
            assert (team / 'dataless.md').read_bytes() == b'original'
            assert (team / 'dataless (빌 수정).md').read_bytes() == b'edited'
            assert not list(out.iterdir()) and not (lib / '.steno').exists()
            print('PASS: 4 dataless return checks (no original inspection, unchanged original, one copy, queue/state)')
