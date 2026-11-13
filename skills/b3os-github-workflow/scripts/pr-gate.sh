#!/usr/bin/env bash
# PR 머지 준비 확인(읽기 전용) — 판정은 pr-gate.py. 사용: pr-gate.sh <owner/repo> <pr>
exec "${B3OS_PYTHON:-python3}" "$(dirname "$0")/pr-gate.py" "$@"
