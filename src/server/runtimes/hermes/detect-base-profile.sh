#!/usr/bin/env bash
# 기존 Hermes 설치에서 공유 auth 원본 프로필을 보수적으로 추론한다.
# stdout: 확신 가능한 프로필명 1개. auth 프로필 없음은 빈 출력/0, 모호하면 2.
set -euo pipefail

PROFILES_ROOT="${1:-$HOME/.hermes/profiles}"
[ -d "$PROFILES_ROOT" ] || exit 0

shared_targets=""
auth_profiles=""
for auth in "$PROFILES_ROOT"/*/auth.json; do
  [ -e "$auth" ] || [ -L "$auth" ] || continue
  profile="$(basename "$(dirname "$auth")")"
  [[ "$profile" =~ ^[A-Za-z0-9_-]+$ ]] || continue
  auth_profiles="${auth_profiles}${auth_profiles:+
}$profile"

  # b3os clone은 auth.json을 base 프로필의 auth.json에 심링크한다.
  if [ -L "$auth" ]; then
    target="$(readlink "$auth" 2>/dev/null || true)"
    case "$target" in
      "$PROFILES_ROOT"/*/auth.json)
        target_profile="$(basename "$(dirname "$target")")"
        if [[ "$target_profile" =~ ^[A-Za-z0-9_-]+$ ]]; then
          shared_targets="${shared_targets}${shared_targets:+
}$target_profile"
        fi
        ;;
    esac
  fi
done

unique_lines() { printf '%s\n' "$1" | awk 'NF && !seen[$0]++'; }

if [ -n "$shared_targets" ]; then
  unique_targets="$(unique_lines "$shared_targets")"
  [ "$(printf '%s\n' "$unique_targets" | awk 'NF{n++} END{print n+0}')" -eq 1 ] || exit 2
  printf '%s\n' "$unique_targets"
  exit 0
fi

unique_auth_profiles="$(unique_lines "$auth_profiles")"
auth_count="$(printf '%s\n' "$unique_auth_profiles" | awk 'NF{n++} END{print n+0}')"
case "$auth_count" in
  0) exit 0 ;;
  1) printf '%s\n' "$unique_auth_profiles" ;;
  *) exit 2 ;;
esac
