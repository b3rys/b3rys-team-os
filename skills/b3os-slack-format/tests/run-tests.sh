#!/usr/bin/env bash
# b3os-slack-format 변환기 회귀 테스트 — examples/*.md를 md-to-slack로 변환해 tests/*.expected.txt와 비교.
# (트레일링 개행은 무시 — command substitution이 정규화)
# 새 예시 추가: examples/NN-name.md 만들고 `python3 scripts/md-to-slack.py examples/NN-name.md > tests/NN-name.expected.txt`.
set -uo pipefail
cd "$(dirname "$0")/.."
pass=0; fail=0
for f in examples/*.md; do
  exp="tests/$(basename "${f%.md}").expected.txt"
  [ -f "$exp" ] || { echo "✗ $(basename "$f") — expected 없음 ($exp)"; fail=$((fail+1)); continue; }
  got="$(python3 scripts/md-to-slack.py "$f")"
  want="$(cat "$exp")"
  if [ "$got" = "$want" ]; then
    echo "✓ $(basename "$f")"; pass=$((pass+1))
  else
    echo "✗ $(basename "$f") — 변환 결과가 expected와 다름:"; diff <(printf '%s\n' "$got") <(printf '%s\n' "$want") | head -10; fail=$((fail+1))
  fi
done
echo "—— slack-format 테스트: ${pass} 통과 / ${fail} 실패 ——"
[ "$fail" -eq 0 ]
