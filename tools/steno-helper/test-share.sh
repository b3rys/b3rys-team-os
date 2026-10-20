#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"; TMP="$(cd "$TMP" && pwd -P)"
trap 'chmod -R u+rw "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
BIN="${STENO_HELPER_TEST_BIN:-$TMP/steno-helper-test}"
[ -x "$BIN" ] || swiftc -D STENO_HELPER_TESTING "$HERE"/Sources/*.swift -o "$BIN"
SRC="$TMP/팀 공유"; DST="$TMP/shared"
mkdir -p "$SRC" "$DST"
printf " team\n" > "$SRC/.steno-folder"
pass=0
ok() { pass=$((pass + 1)); }
fail() { echo "FAIL: $1" >&2; exit 1; }
sync() { "$BIN" --share "$SRC" "$DST" 2>/dev/null || true; }
srcsum() { find "$SRC" -type f -exec shasum {} + | sort; }

# 1. 처음 복사 + manifest 기록, 원본 무수정
printf v1 > "$SRC/AAA.md"
before="$(srcsum)"
sync
[ "$(cat "$DST/AAA.md")" = v1 ] || fail "first copy"; ok
grep -q '"AAA.md"' "$DST/.manifest.json" || fail "manifest entry"; ok
[ "$(srcsum)" = "$before" ] || fail "source changed"; ok

# 2. 원본만 바뀜 → 사본 갱신
printf v2 > "$SRC/AAA.md"; sync
[ "$(cat "$DST/AAA.md")" = v2 ] || fail "source update"; ok

# 3. 팀원이 사본을 고침 → 원본이 그대로면 사본 유지
printf team > "$DST/AAA.md"; sync
[ "$(cat "$DST/AAA.md")" = team ] || fail "team edit kept"; ok

# 4. 원본도 바뀜 → 사본은 여전히 유지, manifest source 는 새 원본 해시
printf gd > "$SRC/AAA.md"; sync
[ "$(cat "$DST/AAA.md")" = team ] || fail "both changed keeps copy"; ok
gdhash="$(printf gd | shasum -a 256 | cut -d' ' -f1)"
grep -q "$gdhash" "$DST/.manifest.json" || fail "manifest source hash"; ok

# 5. 되돌려 넣은 뒤(원본 = 사본) → 새 기준으로 맞춤
printf team > "$SRC/AAA.md"; sync
teamhash="$(printf team | shasum -a 256 | cut -d' ' -f1)"
[ "$(grep -c "$teamhash" "$DST/.manifest.json")" = 2 ] || fail "rebase after return"; ok

# 6. 건너뛰기: 숨김, .steno 사이드카, 비밀 이름, 링크, 폴더, 실행 확장자, 20MB 초과
printf x > "$SRC/.hidden.md"; mkdir -p "$SRC/.steno"; printf x > "$SRC/.steno/ai-edits.json"
printf x > "$SRC/api-token.md"; printf x > "$SRC/run.command"; mkdir "$SRC/.숨김"; printf x > "$SRC/.숨김/in.md"
printf secret > "$TMP/outside.md"; ln -s "$TMP/outside.md" "$SRC/링크.md"
dd if=/dev/zero of="$SRC/큼.md" bs=1048576 count=21 2>/dev/null
sync
for n in .hidden.md .steno api-token.md run.command .숨김 링크.md 큼.md; do
  [ ! -e "$DST/$n" ] || fail "skip $n"; ok
done

# 6b. 하위 폴더(앱과 같은 깊이: 팀 공유/A/B 까지) — 구조 그대로 복사, 더 깊은 것·비밀 이름 폴더·링크 폴더는 건너뜀
mkdir -p "$SRC/발표/초안/더깊이" "$SRC/my-token" ; printf s1 > "$SRC/발표/a.md"; printf s2 > "$SRC/발표/초안/b.md"
printf s3 > "$SRC/발표/초안/더깊이/c.md"; printf s4 > "$SRC/my-token/d.md"
mkdir -p "$TMP/밖폴더"; printf out > "$TMP/밖폴더/e.md"; ln -s "$TMP/밖폴더" "$SRC/링크폴더"
sync
[ "$(cat "$DST/발표/a.md")" = s1 ] || fail "subfolder copy"; ok
[ "$(cat "$DST/발표/초안/b.md")" = s2 ] || fail "second level copy"; ok
[ ! -e "$DST/발표/초안/더깊이" ] || fail "third level skipped"; ok
[ ! -e "$DST/my-token" ] || fail "sensitive folder skipped"; ok
[ ! -e "$DST/링크폴더" ] || fail "linked folder skipped"; ok
python3 -c 'import json,sys,unicodedata; m=json.load(open(sys.argv[1])); assert unicodedata.normalize("NFC","발표/초안/b.md") in m' "$DST/.manifest.json" || fail "subfolder manifest key"; ok
printf edited > "$DST/발표/a.md"; printf s1b > "$SRC/발표/a.md"; sync
[ "$(cat "$DST/발표/a.md")" = edited ] || fail "subfolder team edit kept"; ok
rm "$SRC/발표/초안/b.md"; rmdir "$SRC/발표/초안/더깊이" 2>/dev/null || rm -rf "$SRC/발표/초안/더깊이"; rmdir "$SRC/발표/초안"; sync
[ ! -e "$DST/발표/초안/b.md" ] || fail "subfolder removed copy"; ok
[ ! -e "$DST/발표/초안" ] || fail "empty mirror folder removed"; ok
[ "$(cat "$DST/발표/a.md")" = edited ] || fail "edited subfolder copy kept"; ok
rm -rf "$SRC/발표" "$SRC/my-token" "$SRC/링크폴더" "$DST/발표"
sync

# 7. 팀 공유에서 빠짐: 안 고친 사본은 지우고, 고친 사본은 남김
printf b > "$SRC/BBB.md"; printf c > "$SRC/CCC.md"; sync
printf edited > "$DST/CCC.md"
rm "$SRC/BBB.md" "$SRC/CCC.md"; sync
[ ! -e "$DST/BBB.md" ] || fail "removed untouched copy"; ok
[ "$(cat "$DST/CCC.md")" = edited ] || fail "edited copy kept"; ok

# 8. 목록엔 있지만 못 읽는 파일(iCloud 미다운로드 대역) → 사본 안 지움
printf d > "$SRC/DDD.md"; sync
chmod 000 "$SRC/DDD.md"; sync
grep -A3 '"DDD.md"' "$DST/.manifest.json" | grep -q '"source" : "unreadable"' || fail "unreadable marks source"; ok
chmod 600 "$SRC/DDD.md"
[ "$(cat "$DST/DDD.md")" = d ] || fail "unreadable keeps copy"; ok

# 8a. 사본을 못 읽으면(권한) 원본이 바뀌어도 덮지 않음
printf f1 > "$SRC/FFF.md"; sync; chmod 000 "$DST/FFF.md"
printf f2 > "$SRC/FFF.md"; sync; chmod 600 "$DST/FFF.md"
[ "$(cat "$DST/FFF.md")" = f1 ] || fail "unreadable copy untouched"; ok

# 8c. NFD 이름: manifest 키는 NFC, file 칸은 디스크 이름
nfd="$(python3 -c 'import unicodedata;print(unicodedata.normalize("NFD","한글.md"))')"
printf k > "$SRC/$nfd"; sync
python3 - "$DST/.manifest.json" <<'PY' || fail "nfc key"
import json, sys, unicodedata
m = json.load(open(sys.argv[1])); e = m[unicodedata.normalize("NFC", "한글.md")]
assert e["file"] == unicodedata.normalize("NFD", "한글.md")
PY
ok

# 8b. 팀 공유 폴더를 못 읽으면(권한·iCloud 오류) 사본을 하나도 지우지 않음
chmod 300 "$SRC"; sync; chmod 700 "$SRC"
[ "$(cat "$DST/DDD.md")" = d ] && [ -e "$DST/AAA.md" ] || fail "unreadable folder keeps copies"; ok

# 9. 팀 폴더 안 같은 이름 링크 → 링크 대상은 안 바뀌고 링크만 교체
printf target > "$TMP/victim.txt"
printf e > "$SRC/EEE.md"; ln -s "$TMP/victim.txt" "$DST/EEE.md"; sync
[ "$(cat "$TMP/victim.txt")" = target ] || fail "symlink target untouched"; ok

# 10. 팀 폴더가 링크면 거절, 팀 공유가 없으면 조용히 끝
ln -s "$DST" "$TMP/linked"
if "$BIN" --share "$SRC" "$TMP/linked" 2>/dev/null; then fail "linked destination"; fi; ok
"$BIN" --share "$TMP/없음" "$DST" || fail "missing source should be ok"; ok

# New upload: bytes/SHA, collision suffix and stripped execute bits.
LIB="$TMP/library"; OUT="$TMP/share-outbox"
mkdir -p "$LIB/팀 공유" "$OUT"; printf team > "$LIB/팀 공유/.steno-folder"
printf upload > "$OUT/new.md"; chmod 700 "$OUT/new.md"
"$BIN" --upload "$OUT" "$LIB"
[ "$(shasum -a 256 "$LIB/팀 공유/new.md" | cut -d' ' -f1)" = "$(printf upload | shasum -a 256 | cut -d' ' -f1)" ] || fail "new upload SHA"; ok
[ "$(stat -f %Lp "$LIB/팀 공유/new.md")" = 600 ] || fail "upload mode"; ok
[ ! -e "$OUT/new.md" ] || fail "upload consumes source"; ok
printf second > "$OUT/new.md"; "$BIN" --upload "$OUT" "$LIB"
[ "$(cat "$LIB/팀 공유/new.md")" = upload ] && [ "$(cat "$LIB/팀 공유/new 2.md")" = second ] || fail "upload collision"; ok
ln -s "$TMP/outside.md" "$OUT/link.md"; mkdir "$OUT/folder.md"
dd if=/dev/zero of="$OUT/big.md" bs=1048576 count=21 2>/dev/null
if "$BIN" --upload "$OUT" "$LIB" 2>/dev/null; then fail "unsafe upload accepted"; fi
for n in link.md folder.md big.md; do [ ! -e "$LIB/팀 공유/$n" ] || fail "unsafe upload $n"; ok; done
rm "$OUT/link.md" "$OUT/big.md"; [ ! -e "$OUT/folder.md" ] || fail "empty outbox folder is a subfolder and is removed"; ok
# 하위 폴더로 올리기: 보낼 칸/A/B/x.md → 팀 공유/A/B/x.md (없으면 만든다), 비운 보낼 칸 폴더는 지운다. 세 단계는 거절.
mkdir -p "$OUT/발표/초안"; printf up1 > "$OUT/발표/x.md"; printf up2 > "$OUT/발표/초안/y.md"
"$BIN" --upload "$OUT" "$LIB"
[ "$(cat "$LIB/팀 공유/발표/x.md")" = up1 ] && [ "$(cat "$LIB/팀 공유/발표/초안/y.md")" = up2 ] || fail "upload into subfolder"; ok
[ ! -e "$OUT/발표" ] || fail "emptied outbox folder removed"; ok
mkdir -p "$OUT/a/b/c"; printf deep > "$OUT/a/b/c/z.md"
if "$BIN" --upload "$OUT" "$LIB" 2>/dev/null; then fail "third level upload accepted"; fi
[ ! -e "$LIB/팀 공유/a/b/c" ] || fail "third level not created"; ok
rm -rf "$OUT/a" "$LIB/팀 공유/a"
SEND_HOME="$TMP/send-home"; mkdir -p "$SEND_HOME"
printf send > "$TMP/send.md"
HOME="$SEND_HOME" "$HERE/../../skills/b3os-team-inbox/scripts/steno-send.sh" "$TMP/send.md" >/dev/null
[ -f "$SEND_HOME/Library/Application Support/b3os/steno-share-outbox/send.md" ] || fail "send defaults to team"; ok

python3 "$HERE/test-return.py" "$BIN" "$HERE/steno-share-return.py"


# Same-named user folders must not be shared.
rm "$SRC/.steno-folder"
printf private > "$SRC/Private.md"
sync
[ ! -e "$DST/Private.md" ] || fail "unmarked user folder shared"; ok
# An iCloud marker placeholder identifies the folder while its contents are pending.
: > "$SRC/.steno-folder.icloud"
sync
[ "$(cat "$DST/Private.md")" = private ] || fail "cloud marker placeholder"; ok
rm "$SRC/.steno-folder.icloud"
printf team > "$SRC/.steno-folder"

# An unreadable cloud source requests downloading once across helper invocations.
printf pending > "$SRC/Cloud.md"
chmod 000 "$SRC/Cloud.md"
sync
python3 - "$DST/.manifest.json" <<'CHECK'
import json,sys
assert json.load(open(sys.argv[1]))['Cloud.md']['downloadRequested'] == '1'
CHECK
ok
sync
python3 - "$DST/.manifest.json" <<'CHECK'
import json,sys
assert json.load(open(sys.argv[1]))['Cloud.md']['downloadRequested'] == '1'
CHECK
ok
chmod 600 "$SRC/Cloud.md"
sync
[ "$(cat "$DST/Cloud.md")" = pending ] || fail "cloud source copied on next readable cycle"; ok
chmod 000 "$SRC/Cloud.md"
sync
python3 - "$DST/.manifest.json" <<'CHECK'
import json,sys
assert json.load(open(sys.argv[1]))['Cloud.md']['downloadRequested'] == '1'
CHECK
ok
chmod 600 "$SRC/Cloud.md"

# 라이브러리 결정과 세 작업을 임시 HOME에서 함께 시험한다.
python3 - "$BIN" "$TMP" <<'CHECK'
import json, os, pathlib, subprocess, sys
bin, tmp = sys.argv[1:]
home = pathlib.Path(tmp) / 'resolve-home'
support = home / 'Library/Application Support/b3os'
support.mkdir(parents=True)
record_dir = home / 'Library/Application Support/Steno'
record_dir.mkdir()
path_file = record_dir / 'library-location.json'
def record(path):
    path_file.write_text(json.dumps({'path': str(path), 'bookmark': 'ignored'}))
default = home / 'Documents/Steno'
icloud = home / 'Library/Mobile Documents/iCloud~com~b3rys~steno/Documents'
env_library = pathlib.Path(tmp) / 'env-library'
moved = pathlib.Path(tmp) / '옮긴 라이브러리'
next_library = pathlib.Path(tmp) / '다시 옮긴 라이브러리'
for library in (default, icloud, env_library, moved, next_library):
    (library / '받은 파일').mkdir(parents=True)
    (library / '팀 공유').mkdir()
    (library / '팀 공유/.steno-folder').write_text('team')
for name in ('steno-outbox', 'steno-share-outbox', 'steno-shared'):
    (support / name).mkdir()
env = dict(os.environ)
env.pop('STENO_LIBRARY', None)
env['HOME'] = str(home)
checks = 0

def run(mode, value=None):
    e = dict(env)
    if value is not None:
        e['STENO_LIBRARY'] = value
    return subprocess.run([bin, mode, str(home)], env=e, capture_output=True, text=True, timeout=10)

def resolve(expected, value=None, rejected=False):
    global checks
    result = run('--resolve', value)
    assert result.returncode == 0, result.stderr
    assert result.stdout.rstrip('\n') == str(expected), result
    if rejected:
        assert '거절:' in result.stderr, result
    checks += 1

def cycle(library, tag, value=None):
    global checks
    (support / 'steno-outbox' / (tag + '-in.md')).write_text('inbox')
    (support / 'steno-share-outbox' / (tag + '-up.md')).write_text('upload')
    result = run('--cycle', value)
    assert result.returncode == 0, result.stderr
    assert (library / '받은 파일' / (tag + '-in.md')).read_text() == 'inbox'
    assert (library / '팀 공유' / (tag + '-up.md')).read_text() == 'upload'
    assert (support / 'steno-shared' / (tag + '-up.md')).read_text() == 'upload'
    assert not (support / 'steno-outbox' / (tag + '-in.md')).exists()
    assert not (support / 'steno-share-outbox' / (tag + '-up.md')).exists()
    checks += 1

# 예전 b3os 파일은 사용하지 않는다.
(support / 'steno-library-path').write_text(str(env_library))
record(moved)
resolve(moved, str(env_library))
cycle(moved, 'moved', str(env_library))
assert not (default / '받은 파일/moved-in.md').exists()
assert not (env_library / '팀 공유/moved-up.md').exists()
record(next_library)
cycle(next_library, 'next', str(env_library))
path_file.unlink()
resolve(env_library, str(env_library))
cycle(env_library, 'env', str(env_library))
resolve(icloud)
cycle(icloud, 'icloud')
resolve(icloud, str(home / 'removed-library'), rejected=True)
cycle(icloud, 'removed-env', str(home / 'removed-library'))

link = pathlib.Path(tmp) / 'linked-library'
link.symlink_to(moved, target_is_directory=True)
parent_link = pathlib.Path(tmp) / 'linked-parent'
parent_link.symlink_to(moved.parent, target_is_directory=True)
regular = pathlib.Path(tmp) / 'not-directory'
regular.write_text('x')
invalid = ['relative/path', str(link), str(parent_link / moved.name),
           str(home / 'missing'), str(regular), '/' + 'x' * 1024,
           str(moved) + '\nextra', str(moved) + '\x00ignored', str(moved) + '\r', '']
for value in invalid:
    record(value)
    resolve(env_library, str(env_library), rejected=True)
    resolve(icloud, 'relative-env', rejected=True)
for bad_json in ('{broken', '{}', '{"path": 123}'):
    path_file.write_text(bad_json)
    resolve(env_library, str(env_library), rejected=True)
path_file.write_bytes(b'\xff')
resolve(env_library, str(env_library), rejected=True)
record(moved)
path_file.chmod(0)
try:
    resolve(env_library, str(env_library), rejected=True)
    assert '권한 없음 — 시스템 설정 › 개인정보 › 파일 및 폴더에서 steno-helper 허용 필요' in run('--resolve', str(env_library)).stderr
finally:
    path_file.chmod(0o600)
path_file.write_bytes(b'x' * 65537)
resolve(env_library, str(env_library), rejected=True)
cycle(env_library, 'invalid-file', str(env_library))
path_file.unlink()
for value in invalid:
    if '\x00' not in value:
        resolve(icloud, value, rejected=True)

other_file = pathlib.Path(tmp) / 'path-target'
other_file.write_text(json.dumps({'path': str(moved)}))
path_file.symlink_to(other_file)
resolve(env_library, str(env_library), rejected=True)
path_file.unlink()
path_file.mkdir()
resolve(env_library, str(env_library), rejected=True)
path_file.rmdir()
os.mkfifo(path_file)
resolve(env_library, str(env_library), rejected=True)
path_file.unlink()
os.link(other_file, path_file)
resolve(env_library, str(env_library), rejected=True)
path_file.unlink()
record_dir.rename(record_dir.with_name('Steno-real'))
record_dir.symlink_to(record_dir.with_name('Steno-real'), target_is_directory=True)
resolve(icloud, rejected=True)
record_dir.unlink()
record_dir.with_name('Steno-real').rename(record_dir)
# 접근 거부도 다음 후보로 넘어가고 권한 안내를 남긴다.
mobile = home / 'Library/Mobile Documents'
mobile.chmod(0)
try:
    resolve(default, rejected=True)
    result = run('--resolve')
    assert '권한 없음 — 시스템 설정 › 개인정보 › 파일 및 폴더에서 steno-helper 허용 필요' in result.stderr
finally:
    mobile.chmod(0o700)
icloud.rename(icloud.with_name('Documents-old'))
resolve(default)
cycle(default, 'default')
default.rename(default.with_name('Steno-old'))
(support / 'steno-outbox/keep.md').write_text('keep')
result = run('--cycle')
assert result.returncode == 1 and '문서 기본값 거절:' in result.stderr
assert (support / 'steno-outbox/keep.md').read_text() == 'keep'
checks += 1
print(f'PASS: {checks} 라이브러리 경로 checks')
CHECK

echo "PASS: $pass 팀 공유 checks"
