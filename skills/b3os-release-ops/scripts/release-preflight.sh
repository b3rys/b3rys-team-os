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
Usage: release-preflight.sh [--mode merge|deploy|force-push|post-merge] [--base origin/main] [--live-dir PATH]
       [--pr N] [--settings-url URL] [--skip-approver-check REASON] [--skip-branch-protection] [--allow-main]

  NOTE: --mode hotfix was REMOVED (it skipped the approver check silently). A hotfix uses --mode merge.
  NOTE: --pr N must be this branch's own PR — it is checked. Omit --pr to derive it from the branch.

Checks:
  - clean git worktree
  - non-main branch for merge unless --allow-main
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
    # ★이유 자리가 다음 플래그를 삼키면 안 된다★ (steve 실측):
    #   `--skip-approver-check --allow-main` 이 ★reason="--allow-main" 으로 통과★ 했고,
    #   ★사용자가 준 --allow-main 은 조용히 사라졌다★ — 적용도 경고도 없이.
    #   ①이유 필수 가드가 무력화되고 ②사용자 인자가 소리 없이 증발한다.
    #   ★우회 경로는 이 게이트의 마지막 방어선이라 거기가 제일 튼튼해야 한다.★
    --skip-approver-check)
      # ★공백만 있는 이유도 이유가 아니다★ (ames 2차 실측): `--skip-approver-check "   "` 가
      #   ★rc=0 · reason:"   " 로 통과★ 했다. ★'왜 우회했는지 기록' 계약이 빈 기록으로 무력화된다.★
      #   ★앞뒤 공백을 벗긴 뒤★ 판정한다 — 벗기고 나서 비었거나 `-` 로 시작하면 거부.
      #   (bash 3.2 호환 트림 — macOS 기본 셸이 3.2 다)
      _r="${2:-}"
      _r="${_r#"${_r%%[![:space:]]*}"}"
      _r="${_r%"${_r##*[![:space:]]}"}"
      case "$_r" in
        ''|-*) fail "--skip-approver-check needs a real reason (not a flag, not blank): --skip-approver-check REASON" ;;
      esac
      CHECK_APPROVER=0; SKIP_REASON="$_r"; shift 2 ;;
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
  merge|deploy|force-push|post-merge) ;;
  # ★hotfix 를 없앴다★ (하네스 실측 2026-07-29): 받아주는 목록에는 있는데 ★승인 확인부에는 없어서★
  #   `--mode hotfix` 를 쓰면 ★승인 확인을 조용히 건너뛰고 "passed" 를 찍었다.★ 경고 한 줄도 없었다.
  #   ★문서 어디에도 이 모드를 쓰라는 절차가 없었다★ — 급할 때도 merge 를 쓰라고 적혀 있다.
  #   ★안 쓰이는데 받아주기만 하는 이름은 지운다★ (이름만 보고 집기 딱 좋은 자리였다).
  hotfix) fail "--mode hotfix was removed: it skipped the approver check silently. Use --mode merge (a hotfix still needs an approval); for a real emergency use --mode merge --skip-approver-check \"why\" — that path is loud and recorded" ;;
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
  PR_WAS_EXPLICIT=1
  if [ -z "$PR_NUMBER" ]; then
    PR_WAS_EXPLICIT=0
    PR_NUMBER="$(gh pr view --json number --jq .number 2>/dev/null || true)"
  fi
  [ -n "$PR_NUMBER" ] || fail "PR number unknown; pass --pr <n> (or run on a branch with an open PR)"

  # ★승인을 지금 머지하려는 것에 묶는다★ (하네스 실측 2026-07-29)
  #   예전엔 `--pr N` 을 주면 ★그 PR 이 이 브랜치의 것인지 한 번도 묻지 않았다.★
  #   → ★예전에 승인받은 아무 PR 번호★ 하나면 ★리뷰 안 받은 브랜치가 통과★ 했다.
  #   번호를 안 주면 현재 브랜치에서 유도하므로 원래 묶여 있다 — ★손으로 주는 순간 끊겼다.★
  #   ★그래서 손으로 준 경우에만 대조한다★ (유도한 경우는 이미 같은 것이다).
  if [ "$PR_WAS_EXPLICIT" -eq 1 ]; then
    PR_HEAD_REF="$(gh pr view "$PR_NUMBER" --json headRefName --jq .headRefName 2>/dev/null || true)"
    PR_HEAD_SHA="$(gh pr view "$PR_NUMBER" --json headRefOid --jq .headRefOid 2>/dev/null || true)"
    [ -n "$PR_HEAD_REF" ] || fail "could not read PR #$PR_NUMBER head branch — cannot tie the approval to what is being merged"
    if [ "$PR_HEAD_REF" != "$BRANCH" ]; then
      fail "PR #$PR_NUMBER is for branch '$PR_HEAD_REF' but you are on '$BRANCH' — an approval on a different PR does not approve this branch (drop --pr to use this branch's own PR)"
    fi
    if [ -n "$PR_HEAD_SHA" ] && [ "$PR_HEAD_SHA" != "$(git rev-parse HEAD)" ]; then
      fail "PR #$PR_NUMBER head is $(printf '%.7s' "$PR_HEAD_SHA") but local HEAD is $(git rev-parse --short HEAD) — push first so the approval refers to these commits"
    fi
    ok "PR #$PR_NUMBER matches this branch ($BRANCH)"
  fi

  SETTINGS_JSON="$(curl -fsS "$SETTINGS_URL" 2>/dev/null || true)"
  # ★설정을 못 읽으면 통과시키지 않는다★ — '확인 불가' 는 '통과' 가 아니다.
  [ -n "$SETTINGS_JSON" ] || fail "settings unreadable at $SETTINGS_URL — cannot verify approver (this is 'unknown', not 'ok')"

  # ★--slurp 를 붙인다★ (하네스 실측 2026-07-29): `--paginate` 는 ★페이지마다 별개 JSON★ 을 이어 붙인다
  #   (gh 자체 도움말: "Each page is a separate JSON array or object. Pass --slurp to wrap all pages").
  #   그래서 ★리뷰가 30건 넘는 PR★ 에서 json 파싱이 깨지고 "could not run" 으로 막혔다 —
  #   ★가장 리뷰가 많은(=가장 중요한) PR 에서 원인불명으로 막히고 --skip 으로 몰린다.★
  #   --slurp 는 [[page1],[page2]] 로 감싸므로 아래 인코딩 단계에서 평탄화한다.
  REVIEWS_JSON="$(gh api "repos/$(repo_slug)/pulls/$PR_NUMBER/reviews" --paginate --slurp 2>/dev/null || true)"
  [ -n "$REVIEWS_JSON" ] || fail "could not read reviews for PR #$PR_NUMBER — cannot verify approver"

  PR_AUTHOR="$(gh pr view "$PR_NUMBER" --json author --jq .author.login 2>/dev/null || true)"

  # ★판정은 부품으로 뺐다★ — 네트워크·계정 없이 시험할 수 있어야 하기 때문이다.
  #   ★게이트는 여전히 이 스크립트 하나다.★ (진입점을 늘리지 않는다)
  #   ★stdin 으로 넘긴다★ — argv 면 리뷰가 많은 PR 에서 Argument list too long 이 난다.
  APPROVER_REPORT="$(printf '%s' "$(SETTINGS_JSON="$SETTINGS_JSON" REVIEWS_JSON="$REVIEWS_JSON" PR_AUTHOR="$PR_AUTHOR" "${B3OS_PYTHON:-python3}" -c '
import json, os, sys
# ★--slurp 는 페이지를 [[...],[...]] 로 감싼다★ — 한 겹 벗겨서 리뷰 목록으로 만든다.
#   ★리스트가 아닌 응답은 손대지 않고 그대로 넘긴다★ — 판정기가 "모르면 막는다" 로 처리해야 한다.
reviews = json.loads(os.environ["REVIEWS_JSON"] or "[]")
if isinstance(reviews, list) and reviews and all(isinstance(p, list) for p in reviews):
    reviews = [r for page in reviews for r in page]
json.dump({"settings": json.loads(os.environ["SETTINGS_JSON"]),
           "reviews": reviews,
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

# ★마지막 줄에 '무엇을 어떤 범위로 봤나' 를 같이 찍는다★ (하네스 실측 2026-07-29)
#   예전엔 "release preflight passed" 한 줄이라 ★--base 로 범위를 좁혔는지 보고만 봐서는 알 수 없었다★
#   (--base HEAD~1 이면 그 앞 커밋의 실메일 유출이 감사에서 통째로 빠지는데 출력은 똑같았다).
#   ★우회 사실도 stdout 에 남긴다★ — 예전엔 stderr 에만 있어서
#   ★stdout 만 캡처하거나 종료코드만 보는 호출자에겐 우회가 안 보였다.★
SUMMARY="release preflight passed (mode=$MODE"
[ "$MODE" = "deploy" ] || [ "$MODE" = "post-merge" ] || SUMMARY="$SUMMARY, base=$BASE"
[ -n "${SKIPPED_NOTE:-}" ] && SUMMARY="$SUMMARY, ★APPROVER CHECK SKIPPED: $SKIP_REASON★"
[ "$SETTINGS_URL" = "http://127.0.0.1:7878/team/api/settings" ] || SUMMARY="$SUMMARY, ★non-default settings source: $SETTINGS_URL★"
[ -z "${B3OS_PYTHON:-}" ] || SUMMARY="$SUMMARY, ★non-default python: $B3OS_PYTHON★"
ok "$SUMMARY)"
