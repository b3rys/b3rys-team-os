#!/usr/bin/env bash
# b3os release preflight — merge/deploy/hotfix/force-push gate checks.
set -euo pipefail

MODE="merge"
BASE="origin/main"
LIVE_DIR=""
CHECK_BRANCH_PROTECTION=1
ALLOW_MAIN=0

usage() {
  cat <<'USAGE'
Usage: release-preflight.sh [--mode merge|deploy|hotfix|force-push] [--base origin/main] [--live-dir PATH] [--skip-branch-protection] [--allow-main]

Checks:
  - clean git worktree
  - non-main branch for merge/hotfix unless --allow-main
  - commits in BASE..HEAD use GitHub noreply author email
  - GitHub main branch protection exists (via gh api) unless skipped
  - deploy live-dir is a b3rys-team-os public repo clone
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
    --skip-branch-protection) CHECK_BRANCH_PROTECTION=0; shift ;;
    --allow-main) ALLOW_MAIN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown arg: $1" ;;
  esac
done

case "$MODE" in
  merge|deploy|hotfix|force-push) ;;
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
if [ "$ALLOW_MAIN" -ne 1 ] && [ "$MODE" != "deploy" ]; then
  [ "$BRANCH" != "main" ] || fail "do not merge/hotfix directly from main"
fi
ok "branch check: ${BRANCH:-detached}"

git fetch origin main -q || fail "git fetch origin main failed"
git rev-parse --verify "$BASE" >/dev/null 2>&1 || fail "base not found: $BASE"

if [ "$MODE" = "merge" ] || [ "$MODE" = "hotfix" ]; then
  AHEAD_COUNT="$(git rev-list --count "$BASE"..HEAD)"
  [ "$AHEAD_COUNT" -gt 0 ] || fail "no commits ahead of $BASE"
  BAD_EMAILS="$(git log --format='%h %ae' "$BASE"..HEAD | while read -r sha email; do
    if [[ "$email" != *@users.noreply.github.com ]]; then
      printf '%s %s\n' "$sha" "$email"
    fi
  done)"
  if [ -n "$BAD_EMAILS" ]; then
    printf '%s\n' "$BAD_EMAILS" >&2
    fail "non-noreply author email found in $BASE..HEAD"
  fi
  ok "all $AHEAD_COUNT commit author emails are GitHub noreply"
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

if [ "$MODE" = "force-push" ]; then
  warn "force-push/history rewrite still requires GD approval, backup, secret scan, 2-person or harness review, and rollback commands"
fi

ok "release preflight passed"
