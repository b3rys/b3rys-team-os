#!/usr/bin/env bash
# snapshot-cloud-prune.sh <폴더> <남길 개수> — 기기 밖(iCloud) 폴더의 b3os 스냅샷을 최신 N개만 남긴다.
#   이름(b3os-snapshot-YYYYMMDD-HHMMSS)이 시각순이라 이름으로 정렬한다. 다른 파일은 건드리지 않는다.
set -euo pipefail
DIR="$1"; KEEP="$2"
case "$KEEP" in ''|*[!0-9]*|0) echo "남길 개수가 1 이상의 숫자가 아니다: $KEEP" >&2; exit 2 ;; esac
[ -d "$DIR" ] || exit 0
ls -1 "$DIR"/b3os-snapshot-*.tar.gz 2>/dev/null | sort -r | tail -n +$((KEEP+1)) | while IFS= read -r f; do
  rm -f -- "$f" && echo "  기기밖 삭제(로테이션): $(basename "$f")"
done
