#!/usr/bin/env bash
# b3os release preflight — merge/deploy/hotfix/force-push gate checks.
set -euo pipefail

MODE="merge"
BASE="origin/main"
LIVE_DIR=""
CHECK_BRANCH_PROTECTION=1
ALLOW_MAIN=0
PR_NUMBER=""
CHECK_APPROVER=1
SKIP_REASON=""
SETTINGS_URL="${B3OS_SETTINGS_URL:-http://127.0.0.1:7878/team/api/settings}"

usage() {
  cat <<'USAGE'
Usage: release-preflight.sh [--mode merge|deploy|hotfix|force-push|post-merge] [--base origin/main] [--live-dir PATH]
       [--pr N] [--settings-url URL] [--skip-approver-check] [--skip-branch-protection] [--allow-main]

Checks:
  - clean git worktree
  - non-main branch for merge/hotfix unless --allow-main
  - commits in BASE..HEAD use GitHub noreply author and committer email
  - post-merge origin/main tip uses GitHub noreply author and committer email
  - force-push annotated tags use GitHub noreply tagger email
  - GitHub main branch protection exists (via gh api) unless skipped
  - deploy live-dir is a b3rys-team-os public repo clone
  - merge: the standing approval carries 'Approved-by: <name>' and that name is in merge_approvers_normal,
    the approving account matches github_approver_account, and the PR author matches github_team_account
    (all read from settings — nothing about accounts or approvers is hardcoded here)
USAGE
}

fail() { printf '✗ %s\n' "$1" >&2; exit 1; }
ok() { printf '✓ %s\n' "$1"; }
warn() { printf '⚠ %s\n' "$1" >&2; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --base) BASE="${2:-}"; shift 2 ;;
    --live-dir) LIVE_DIR="${2:-}"; shift 2 ;;
    --pr) PR_NUMBER="${2:-}"; shift 2 ;;
    --settings-url) SETTINGS_URL="${2:-}"; shift 2 ;;
    --skip-approver-check) CHECK_APPROVER=0; SKIP_REASON="${2:-}"; shift 2 ;;
    --skip-branch-protection) CHECK_BRANCH_PROTECTION=0; shift ;;
    --allow-main) ALLOW_MAIN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown arg: $1" ;;
  esac
done

# origin URL → owner/repo. ★두 곳에서 쓰므로 함수로 둔다★ (승인자 검사 · 브랜치 보호).
repo_slug() {
  printf '%s\n' "$REMOTE_URL" | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$##'
}

is_noreply_email() {
  local email="$1"
  email="${email#<}"
  email="${email%>}"
  [[ "$email" == *@users.noreply.github.com || "$email" == "noreply@github.com" ]]
}

case "$MODE" in
  merge|deploy|hotfix|force-push|post-merge) ;;
  *) fail "invalid --mode: $MODE" ;;
esac

if [ -n "$LIVE_DIR" ]; then
  cd "$LIVE_DIR"
fi

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "not a git worktree"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

REMOTE_URL="$(git remote get-url origin 2>/dev/null || true)"
printf 'mode=%s repo=%s\n' "$MODE" "$ROOT"
[ -n "$REMOTE_URL" ] || fail "origin remote missing"
printf 'origin=%s\n' "$REMOTE_URL"

case "$REMOTE_URL" in
  *b3rys-team-os*) ok "origin looks like b3rys-team-os" ;;
  *) fail "origin is not b3rys-team-os" ;;
esac

if [ -n "$(git status --porcelain)" ]; then
  git status --short >&2
  fail "worktree is not clean"
fi
ok "worktree clean"

BRANCH="$(git branch --show-current)"
if [ "$ALLOW_MAIN" -ne 1 ] && [ "$MODE" != "deploy" ] && [ "$MODE" != "post-merge" ]; then
  [ "$BRANCH" != "main" ] || fail "do not merge/hotfix directly from main"
fi
ok "branch check: ${BRANCH:-detached}"

git fetch origin main -q || fail "git fetch origin main failed"
git rev-parse --verify "$BASE" >/dev/null 2>&1 || fail "base not found: $BASE"

if [ "$MODE" = "merge" ] || [ "$MODE" = "hotfix" ] || [ "$MODE" = "force-push" ]; then
  AHEAD_COUNT="$(git rev-list --count "$BASE"..HEAD)"
  if [ "$MODE" != "force-push" ]; then
    [ "$AHEAD_COUNT" -gt 0 ] || fail "no commits ahead of $BASE"
  fi
  BAD_EMAILS="$(git log --format='%h%x09%ae%x09%ce' "$BASE"..HEAD | while IFS=$'\t' read -r sha author_email committer_email; do
    if ! is_noreply_email "$author_email"; then
      printf '%s author %s\n' "$sha" "$author_email"
    fi
    if ! is_noreply_email "$committer_email"; then
      printf '%s committer %s\n' "$sha" "$committer_email"
    fi
  done)"
  if [ -n "$BAD_EMAILS" ]; then
    printf '%s\n' "$BAD_EMAILS" >&2
    fail "non-noreply author/committer email found in $BASE..HEAD"
  fi
  ok "all $AHEAD_COUNT commit author/committer emails are GitHub noreply"
fi

if [ "$MODE" = "post-merge" ]; then
  TIP_SHA="$(git rev-parse origin/main)"
  AUTHOR_EMAIL="$(git log -1 --format='%ae' "$TIP_SHA")"
  COMMITTER_EMAIL="$(git log -1 --format='%ce' "$TIP_SHA")"
  if ! is_noreply_email "$AUTHOR_EMAIL"; then
    printf '%s author %s\n' "$(git rev-parse --short "$TIP_SHA")" "$AUTHOR_EMAIL" >&2
    fail "origin/main tip author email is not GitHub noreply"
  fi
  if ! is_noreply_email "$COMMITTER_EMAIL"; then
    printf '%s committer %s\n' "$(git rev-parse --short "$TIP_SHA")" "$COMMITTER_EMAIL" >&2
    fail "origin/main tip committer email is not GitHub noreply"
  fi
  ok "origin/main tip author/committer emails are GitHub noreply: $(git rev-parse --short "$TIP_SHA")"
fi

if [ "$MODE" = "deploy" ]; then
  HEAD_SHA="$(git rev-parse HEAD)"
  TARGET_SHA="$(git rev-parse origin/main)"
  printf 'live HEAD=%s origin/main=%s\n' "$(git rev-parse --short "$HEAD_SHA")" "$(git rev-parse --short "$TARGET_SHA")"
  ok "deploy target resolved"
fi

if [ "$CHECK_BRANCH_PROTECTION" -eq 1 ]; then
  if ! command -v gh >/dev/null 2>&1; then
    fail "gh CLI missing; rerun after gh auth or use --skip-branch-protection and report the skip"
  fi
  SLUG="$(printf '%s\n' "$REMOTE_URL" | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$##')"
  [ -n "$SLUG" ] || fail "could not parse GitHub owner/repo from origin"
  if gh api "repos/$SLUG/branches/main/protection" >/dev/null 2>&1; then
    ok "main branch protection exists: $SLUG"
  else
    fail "main branch protection not readable or missing: $SLUG"
  fi
else
  warn "branch protection check skipped"
fi

# ────────────────────────────────────────────────────────────────────────────
# ★머지 전: 누가 승인했는지 — 계정이 아니라 사람으로 확인한다★  (2026-07-29)
#
# ★왜 필요했나★ 우리 승인 계정은 여럿이 공유한다. GitHub 기록에는 ★계정만 남고 사람은 안 남는다.★
#   그래서 #117 을 머지하면서 "Demis 도장이라 머지했다" 고 알았는데 ★내 도장이었다.★
#   ★'누가 봤는지' 를 잘못 알고 머지를 판단하면, 다음엔 아무도 안 본 걸 머지하게 된다.★
#
# ★왜 산문을 파싱하지 않나★ 처음엔 승인 본문에서 이름을 뽑으려 했다. 리뷰 3인 + 하네스 2인이
#   찾은 결함이 ★전부 같은 원인★ 이었다 — 인용문(`> Steve 승인합니다`)·부정문(`Bill 은 승인 안 했지만`)·
#   할일(`- Bill 승인 필요`)·조사·역할어(`GD 승인 후`)·이스케이프 개행.
#   ★사람이 쓴 문장에서 기계가 쓸 값을 되찾으려 한 것 자체가 원인이다.★
#   → 승인자는 그 순간 자기가 누군지 안다. ★그때 기계용 한 줄을 남긴다:  Approved-by: <이름>★
#     그러면 판정이 ★정확 일치★ 가 되고 위 오탐 클래스가 통째로 사라진다.
#
# ★명부·계정을 여기에 적지 않는다★ — 전부 설정에서 읽는다. 하드코딩하면 그 순간 갈리고,
#   ★더 느슨한 쪽이 게이트가 된다.★ (실제로 별도 도구에서 17명 명단을 만들어 3명 정본과 갈렸다)
# ★우회로는 남기되 숨기지 않는다★ (demis·steve)
#   빼면 사람들이 ★게이트 자체를 안 돌린다★ — 그게 더 나쁘다. 진짜 비상(설정 서버 다운 + 핫픽스)도 실재한다.
#   대신 ★조용한 우회는 자기부정★ 이다: 기록을 남기는 게 목적인 게이트인데 우회가 기록을 안 남기면
#   ★통과와 우회가 출력상 구분이 안 된다.★ 그래서 이유를 필수로 받고 크게 찍는다.
if [ "$MODE" = "merge" ] && [ "$CHECK_APPROVER" -eq 0 ]; then
  [ -n "$SKIP_REASON" ] || fail "--skip-approver-check requires a reason: --skip-approver-check \"why\""
  warn "★★ APPROVER CHECK SKIPPED ★★ reason: $SKIP_REASON"
  warn "   누가 승인했는지 확인하지 않았습니다 — 이 실행은 '승인 확인됨' 이 아닙니다."
  SKIPPED_NOTE="  ⚠ approver check SKIPPED — $SKIP_REASON"
fi
if [ "$MODE" = "merge" ] && [ "$CHECK_APPROVER" -eq 1 ]; then
  command -v gh >/dev/null 2>&1 || fail "gh CLI missing; needed to read PR reviews"
  if [ -z "$PR_NUMBER" ]; then
    PR_NUMBER="$(gh pr view --json number --jq .number 2>/dev/null || true)"
  fi
  [ -n "$PR_NUMBER" ] || fail "PR number unknown; pass --pr <n> (or run on a branch with an open PR)"

  SETTINGS_JSON="$(curl -fsS "$SETTINGS_URL" 2>/dev/null || true)"
  # ★설정을 못 읽으면 통과시키지 않는다★ — '확인 불가' 는 '통과' 가 아니다.
  [ -n "$SETTINGS_JSON" ] || fail "settings unreadable at $SETTINGS_URL — cannot verify approver (this is 'unknown', not 'ok')"

  REVIEWS_JSON="$(gh api "repos/$(repo_slug)/pulls/$PR_NUMBER/reviews" --paginate 2>/dev/null || true)"
  [ -n "$REVIEWS_JSON" ] || fail "could not read reviews for PR #$PR_NUMBER — cannot verify approver"

  PR_AUTHOR="$(gh pr view "$PR_NUMBER" --json author --jq .author.login 2>/dev/null || true)"

  # ★판정은 부품으로 뺐다★ — 네트워크·계정 없이 시험할 수 있어야 하기 때문이다.
  #   ★게이트는 여전히 이 스크립트 하나다.★ (진입점을 늘리지 않는다)
  #   ★stdin 으로 넘긴다★ — argv 면 리뷰가 많은 PR 에서 Argument list too long 이 난다.
  APPROVER_REPORT="$(printf '%s' "$(SETTINGS_JSON="$SETTINGS_JSON" REVIEWS_JSON="$REVIEWS_JSON" PR_AUTHOR="$PR_AUTHOR" "${B3OS_PYTHON:-python3}" -c '
import json, os, sys
json.dump({"settings": json.loads(os.environ["SETTINGS_JSON"]),
           "reviews": json.loads(os.environ["REVIEWS_JSON"] or "[]"),
           "pr_author": os.environ.get("PR_AUTHOR", "")}, sys.stdout)
' 2>/dev/null)" | "${B3OS_PYTHON:-python3}" "$(dirname "$0")/approver-check.py" 2>/dev/null || true)"
  # ★판정이 안 일어났으면 통과가 아니다★ — 파이썬이 없거나 죽으면 빈 문자열이 온다.
  case "$APPROVER_REPORT" in
    OK*|FAIL*) : ;;
    *) fail "approver check did not run (python3 missing or crashed) — this is 'unknown', not 'ok'" ;;
  esac
  APPROVER_STATUS="${APPROVER_REPORT%%$'\t'*}"
  APPROVER_MSG="${APPROVER_REPORT#*$'\t'}"
  [ "$APPROVER_STATUS" = "OK" ] || fail "approver check: $APPROVER_MSG"
  ok "approver check: $APPROVER_MSG"
fi
# 성공 요약에서도 우회 사실이 보이게 한다 — 스크롤을 놓쳐도 마지막에 다시 뜬다.
[ -n "${SKIPPED_NOTE:-}" ] && printf '%s\n' "$SKIPPED_NOTE" >&2

if [ "$MODE" = "force-push" ]; then
  BAD_TAGGERS="$(git for-each-ref --format='%(refname:short)%09%(objecttype)%09%(taggeremail)' refs/tags | while IFS=$'\t' read -r tag object_type tagger_email; do
    [ "$object_type" = "tag" ] || continue
    peeled="$(git rev-parse -q --verify "$tag^{}" 2>/dev/null || true)"
    [ -n "$peeled" ] || continue
    git merge-base --is-ancestor "$peeled" HEAD || continue
    if git merge-base --is-ancestor "$peeled" "$BASE"; then
      continue
    fi
    if ! is_noreply_email "$tagger_email"; then
      printf '%s tagger %s\n' "$tag" "$tagger_email"
    fi
  done)"
  if [ -n "$BAD_TAGGERS" ]; then
    printf '%s\n' "$BAD_TAGGERS" >&2
    fail "non-noreply tagger email found in tags reachable from $BASE..HEAD"
  fi
  ok "annotated tagger emails in $BASE..HEAD are GitHub noreply"
  warn "force-push/history rewrite still requires GD approval, backup, secret scan, 2-person or harness review, and rollback commands"
fi

ok "release preflight passed"
