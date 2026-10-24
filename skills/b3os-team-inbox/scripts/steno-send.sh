#!/bin/bash
# Steno 지원 파일을 권한 분리된 로컬 outbox에 넣는다.
#
# Usage: steno-send.sh <file> [--name <받는 쪽 파일 이름>] [--folder <하위 폴더 이름>] [--to-received]
#        steno-send.sh <file> [--folder <폴더>] [--name <이름>] --replace   # 팀원이 올린 그 파일을 새 내용으로 바꾼다
#        steno-send.sh --remove [<폴더>/]<이름>                            # 팀원이 올린 그 파일을 치운다
#
#   · Steno 폴더 목록 지원 확장자와 그림·zip만 받는다.
#   · --name 을 안 주면 파일 이름 그대로 쓴다. 경로가 포함된 이름은 거절한다.
#   · --folder 를 주면 팀 공유(또는 받은 파일) 아래 그 폴더에 넣는다. "A" 또는 "A/B"(두 단계까지, 앱 폴더 깊이와 같다). 없으면 도우미가 만든다.
#   · 크기 상한은 20 MB다.
#   · 기본은 덮어쓰지 않는다(같은 이름이면 " 2" 를 붙인다).
#   · --replace / --remove 는 도우미가 올린 파일(팀원이 보낸 것)만 된다. 사람이 Steno 에서 만든 노트는 안 바뀐다.
#     팀원끼리는 구분하지 않는다(같은 사용자라 증명 불가). 사람이 고친 판이어도 바꾼다. 내 것은 팀 공유/<내 이름>/ 에 두는 게 관례다.
#     바뀌기 전 본문은 팀 폴더 steno-shared/.replaced/<해시>.data 에 남는다. 결과는 도우미 로그(b3os-steno-helper.log)에 찍힌다.
# 성공하면 outbox 파일 이름을 stdout 에 찍고 0 으로 끝난다. 실패하면 이유를 stderr 에 찍고 1.
set -uo pipefail
OUTBOX="$HOME/Library/Application Support/b3os/steno-share-outbox"
MAX_BYTES=20971520
ALLOWED="md markdown txt text log csv tsv json yml yaml toml ini conf cfg properties env py rb go rs swift sh bash zsh sql js jsx mjs cjs ts tsx mts cts html htm css xml svg java kt kts scala cs c h cpp cc cxx hpp hh m png jpg jpeg gif webp heic zip"

FILE=""; NAME=""; FOLDER=""; MODE=""; REMOVE_PATH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --to-received) OUTBOX="$HOME/Library/Application Support/b3os/steno-outbox"; shift ;;
    --folder) [ $# -ge 2 ] || { echo "✖ --folder 뒤에 이름이 없다" >&2; exit 1; }; FOLDER="$2"; shift 2 ;;
    --name) [ $# -ge 2 ] || { echo "✖ --name 뒤에 이름이 없다" >&2; exit 1; }; NAME="$2"; shift 2 ;;
    --replace) MODE=replace; shift ;;
    --remove) [ $# -ge 2 ] || { echo "✖ --remove 뒤에 경로가 없다" >&2; exit 1; }; MODE=remove; REMOVE_PATH="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    -*) echo "✖ 모르는 옵션: $1" >&2; exit 1 ;;
    *) [ -z "$FILE" ] || { echo "✖ 파일은 하나만 보낸다" >&2; exit 1; }; FILE="$1"; shift ;;
  esac
done
# 바꾸기·치우기 요청: 본문(.data)을 먼저, 요청(.json)을 마지막에 outbox 바로 아래에 둔다. 도우미가 다음 주기에 처리한다.
replace_request() {  # $1=팀 공유 아래 경로  $2=본문 파일(치우기면 빈 값)
  /usr/bin/python3 -I - "$OUTBOX" "$1" "${2:-}" <<'PYEOF'
import hashlib, json, os, sys, uuid
outbox, rel, data_path = sys.argv[1:]
parts = rel.split("/")
bad = lambda p: (not p) or p in (".", "..") or p.startswith(".") or "\0" in p or "\\" in p
if not (1 <= len(parts) <= 3) or any(bad(p) for p in parts):
    sys.exit("✖ 경로는 <이름>, <폴더>/<이름>, <폴더>/<폴더>/<이름> 중 하나다: " + rel)
low = rel.lower()
if any(w in low for w in ("secret", "credential", "token", "password")) or parts[-1].lower() == ".env":
    sys.exit("✖ 비밀값이 들어갈 수 있는 이름은 쓸 수 없다: " + rel)
os.makedirs(outbox, mode=0o700, exist_ok=True)
if os.path.islink(outbox) or os.path.realpath(outbox) != outbox:
    sys.exit("✖ outbox 가 링크다: " + outbox)
ident = str(uuid.uuid4())
meta = {"file": rel}
if os.environ.get("B3OS_AGENT_ID"): meta["member"] = os.environ["B3OS_AGENT_ID"][:24]  # 로그용
values = []
if data_path:
    with open(data_path, "rb") as f:
        data = f.read()
    meta["sha256"] = hashlib.sha256(data).hexdigest()
    values.append((os.path.join(outbox, ".replace-" + ident + ".data"), data))
else:
    meta["remove"] = True
values.append((os.path.join(outbox, ".replace-" + ident + ".json"), json.dumps(meta, ensure_ascii=False).encode()))
for target, value in values:
    tmp = target + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(value); f.flush(); os.fsync(f.fileno())
    os.rename(tmp, target)
print(rel)
PYEOF
}
if [ "$MODE" = remove ]; then
  [ -z "$FILE" ] || { echo "✖ --remove 는 파일을 받지 않는다" >&2; exit 1; }
  umask 077
  replace_request "$REMOVE_PATH" "" || exit 1
  echo "✓ 치우기 요청 — $REMOVE_PATH (결과는 도우미 로그)" >&2
  exit 0
fi
[ -n "$FILE" ] || { echo "✖ 보낼 파일을 주세요: steno-send.sh <file> [--name <이름>]" >&2; exit 1; }
[ ! -L "$FILE" ] && [ -f "$FILE" ] || { echo "✖ 파일이 없다: $FILE" >&2; exit 1; }
[ -s "$FILE" ] || { echo "✖ 빈 파일이다: $FILE" >&2; exit 1; }
[ "$(stat -f %z "$FILE")" -le "$MAX_BYTES" ] || { echo "✖ 20MB 이하만 보낼 수 있다: $FILE" >&2; exit 1; }
SOURCE_EXT="$(printf '%s' "${FILE##*.}" | tr '[:upper:]' '[:lower:]')"
case " $ALLOWED " in
  *" $SOURCE_EXT "*) ;;
  *) echo "✖ Steno 지원 파일·그림·zip만 보낼 수 있다: $FILE" >&2; exit 1 ;;
esac

[ -n "$NAME" ] || NAME="$(basename "$FILE")"
case "$NAME" in ""|.|..|*/*) echo "✖ 파일 이름에 경로를 쓸 수 없다: $NAME" >&2; exit 1;; esac
LOWER_NAME="$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]')"
case "$LOWER_NAME" in
  .env|*secret*|*credential*|*token*)
    echo "✖ 비밀값이 들어갈 수 있는 파일 이름은 보낼 수 없다: $NAME" >&2
    exit 1
    ;;
esac
EXT="$(printf '%s' "${NAME##*.}" | tr '[:upper:]' '[:lower:]')"
case " $ALLOWED " in
  *" $EXT "*) ;;
  *) echo "✖ Steno 지원 파일·그림·zip만 보낼 수 있다: $NAME" >&2; exit 1 ;;
esac

if [ -n "$FOLDER" ]; then
  case "$FOLDER" in .*|*/.*|*//*|/*|*/|*/*/*|*\\*) echo "✖ 폴더는 \"A\" 또는 \"A/B\" 만(점 시작·빈 칸·세 단계 금지): $FOLDER" >&2; exit 1;; esac
  case "$(printf '%s' "$FOLDER" | tr '[:upper:]' '[:lower:]')" in
    *secret*|*credential*|*token*|*password*) echo "✖ 비밀값이 들어갈 수 있는 폴더 이름은 쓸 수 없다: $FOLDER" >&2; exit 1;;
  esac
fi

if [ "$MODE" = replace ]; then
  [ "$OUTBOX" = "$HOME/Library/Application Support/b3os/steno-share-outbox" ] || { echo "✖ --replace 는 팀 공유에만 쓴다" >&2; exit 1; }
  umask 077
  REL="${FOLDER:+$FOLDER/}$NAME"
  replace_request "$REL" "$FILE" || exit 1
  echo "✓ 바꾸기 요청 — $REL (결과는 도우미 로그)" >&2
  exit 0
fi
umask 077
mkdir -p "$OUTBOX"
chmod 700 "$OUTBOX"
TMP="$(mktemp "$OUTBOX/.steno-send.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
cp "$FILE" "$TMP"
chmod 600 "$TMP"

[ ! -L "$OUTBOX" ] || { echo "✖ outbox 가 링크다: $OUTBOX" >&2; exit 1; }
if [ -n "$FOLDER" ]; then
  # 하위 폴더: 경로 문자열로 확인한 뒤 옮기면 그 사이 폴더를 링크로 바꿔치기할 수 있다(리뷰 #575).
  # outbox 폴더 fd 에서 한 단계씩 O_NOFOLLOW 로 내려가 그 fd 에 바로 놓는다 — 경로를 다시 풀지 않는다.
  # 이름이 겹치면 " 2" … 를 붙인다(link 는 있는 이름을 덮지 않는다).
  SHOWN="$(/usr/bin/python3 -I - "$OUTBOX" "$(basename "$TMP")" "$FOLDER" "$NAME" <<'PYEOF'
import errno, os, sys
outbox, temp, folder, name = sys.argv[1:]
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
root = os.open(outbox, flags)
current = os.dup(root)
for part in folder.split("/"):
    try:
        os.mkdir(part, 0o700, dir_fd=current)
    except FileExistsError:
        pass
    child = os.open(part, flags, dir_fd=current)  # 링크면 ELOOP/ENOTDIR 로 실패
    os.close(current); current = child
hook = os.environ.get("STENO_SEND_TEST_AFTER_DESCEND")
if hook:
    os.system(hook)  # 시험 전용: 내려간 뒤 폴더를 바꿔치기해 본다
stem, dot, ext = name.rpartition(".")
for n in range(1, 10001):
    candidate = name if n == 1 else f"{stem} {n}.{ext}"
    try:
        os.link(temp, candidate, src_dir_fd=root, dst_dir_fd=current, follow_symlinks=False)
    except FileExistsError:
        continue
    os.unlink(temp, dir_fd=root)
    print(f"{folder}/{candidate}")
    sys.exit(0)
sys.exit(1)
PYEOF
)" || { echo "✖ 하위 폴더에 넣지 못했다(링크·권한): $FOLDER" >&2; exit 1; }
else
  DEST="$OUTBOX/$NAME"
  n=2
  while :; do
    mv -n "$TMP" "$DEST" 2>/dev/null || true
    [ ! -e "$TMP" ] && break
    stem="${NAME%.*}"; ext="${NAME##*.}"
    DEST="$OUTBOX/$stem $n.$ext"
    n=$((n + 1))
  done
  SHOWN="$(basename "$DEST")"
fi
trap - EXIT
echo "$SHOWN"
echo "✓ Steno outbox에 넣음 — $SHOWN" >&2
