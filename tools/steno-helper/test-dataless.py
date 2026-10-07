#!/usr/bin/env python3
"""Exercise both real readers with injected stat flags and actual temporary files."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent
share = (root / 'Sources/Share.swift').read_text()
io = (root / 'Sources/UploadFileIO.swift').read_text()
# Keep the production readers and shared predicate; substitute only POSIX calls.
code = share[share.index('private func readRegular('):share.index('\nfunc hasTeamMarker')]
code += io[io.index('func locallyReadableRegular('):io.index('\nfunc uploadSHA256')]
code = code.replace('fstatat(', 'testFstatat(').replace('openat(', 'testOpenat(')
prefix = '''import Darwin
import Foundation
private let maxBytes = 20 * 1_048_576
var flags: UInt32 = 0, opens = 0
func testFstatat(_ dir: Int32, _ name: String, _ info: UnsafeMutablePointer<stat>, _ options: Int32) -> Int32 {
    let result = Darwin.fstatat(dir, name, info, options)
    if result == 0 { info.pointee.st_flags |= flags }
    return result
}
func testOpenat(_ dir: Int32, _ name: String, _ options: Int32) -> Int32 {
    opens += 1
    return Darwin.openat(dir, name, options)
}
'''
suffix = '''
let root = URL(fileURLWithPath: CommandLine.arguments[1])
try Data("ready".utf8).write(to: root.appendingPathComponent("note.md"))
try FileManager.default.createDirectory(at: root.appendingPathComponent("dir.md"), withIntermediateDirectories: true)
let dir = Darwin.open(root.path, O_RDONLY | O_DIRECTORY)
assert(dir >= 0)
for reader in [readRegular, uploadReadRegular] {
    flags = 0; opens = 0
    assert(reader(dir, "note.md") == Data("ready".utf8) && opens == 1)
    flags = UInt32(SF_DATALESS); opens = 0
    assert(reader(dir, "note.md") == nil && opens == 0, "dataless must not open")
    flags |= UInt32(UF_HIDDEN)
    assert(reader(dir, "note.md") == nil && opens == 0, "mixed flags must not open")
    flags = 0
    assert(reader(dir, "dir.md") == nil && opens == 0, "nonregular must not open")
}
close(dir)
print("PASS: 8 shared dataless reader checks (injected metadata, actual temporary files)")
'''
with tempfile.TemporaryDirectory() as tmp:
    home = Path(tmp)
    for name, body in [('baseline', code), ('mutant', code.replace('(info.st_flags & UInt32(SF_DATALESS)) == 0', 'true'))]:
        source, binary = home / (name + '.swift'), home / name
        source.write_text(prefix + body + suffix)
        subprocess.run(['swiftc', str(source), '-o', str(binary)], check=True, capture_output=True)
        fixture = home / (name + '-files'); fixture.mkdir()
        result = subprocess.run([str(binary), str(fixture)], capture_output=True, text=True)
        if name == 'baseline':
            assert result.returncode == 0, result.stderr
            print(result.stdout.strip())
        else:
            assert result.returncode != 0 and 'dataless must not open' in result.stderr, result.stderr
            print('EXPECTED FAIL: shared dataless predicate removed')
