#!/bin/bash
# Steno 도우미 시험: 한 번 빌드해서 받은 파일·팀 공유 시험을 둘 다 돌린다. 실제 문서 폴더는 쓰지 않는다.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export STENO_HELPER_TEST_BIN="$TMP/steno-helper-test"
swiftc -D STENO_HELPER_TESTING "$HERE"/Sources/*.swift -o "$STENO_HELPER_TEST_BIN"
"$HERE/test-inbox.sh"
"$HERE/test-share.sh"
python3 "$HERE/test-dataless.py"
python3 "$HERE/test-original-dataless.py"

if [ -n "${STENO_MERGE_FIXTURES:-}" ]; then
  "$STENO_HELPER_TEST_BIN" --merge-table "$STENO_MERGE_FIXTURES"
else
  echo "SKIP: JS/Swift shared merge table — set STENO_MERGE_FIXTURES to Steno web/test/fixtures/team-share-merge.json" >&2
fi
