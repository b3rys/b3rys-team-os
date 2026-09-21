#!/usr/bin/env bash
# b3os 연결 코드 발급 — 원격 앱(Steno 등)이 팀 서버에 붙을 때 쓰는 한 줄.
#
#   출력 형식:  b3os://<host>/team#<client-id>:<client-secret>
#   값은 stdout 한 줄에만 나온다. 로그·파일·인자에 남기지 않는다.
#
# 두 가지 방식:
#   1) --create <name>   Cloudflare Access 서비스 토큰을 API 로 새로 만든다.
#        필요: CF_ACCOUNT_ID(env) · CF_API_TOKEN_FILE(env, 토큰이 든 파일 경로 — 권한 Access: Service Tokens Edit)
#        만든 뒤 Access 앱 정책(Service Auth)에 이 토큰을 넣고, 서버 .env 의 B3OS_MCP_PRINCIPALS 에
#        "<client-id>:<agent>:<read|write>" 를 추가하고 서버를 재시작해야 실제로 열린다.
#   2) --format          CF 대시보드에서 직접 만든 토큰을 연결 코드로 만든다.
#        Client ID 는 env CF_CLIENT_ID, Secret 은 env CF_CLIENT_SECRET 또는 tty 에서 숨김 입력.
#        (인자로 받지 않는다 — 셸 히스토리·ps 에 남는다.)
#
# 예)  CF_CLIENT_ID=abc.access ./bin/b3os-connect-code.sh --format      # Secret 은 프롬프트
#      CF_ACCOUNT_ID=… CF_API_TOKEN_FILE=~/.config/cf/access-token ./bin/b3os-connect-code.sh --create steno-gd
set -euo pipefail

HOST="${B3OS_CONNECT_HOST:-dev.b3rys.com}"
MODE="${1:-}"

die() { echo "b3os-connect-code: $*" >&2; exit 1; }

case "$MODE" in
  --format)
    CLIENT_ID="${CF_CLIENT_ID:-}"
    [ -n "$CLIENT_ID" ] || die "CF_CLIENT_ID 가 비어 있다 (…access 로 끝나는 Client ID)"
    SECRET="${CF_CLIENT_SECRET:-}"
    if [ -z "$SECRET" ]; then
      [ -t 0 ] || die "CF_CLIENT_SECRET 이 없고 tty 도 아니라 입력받을 수 없다"
      printf 'Client Secret (입력 숨김): ' >&2
      IFS= read -r -s SECRET
      printf '\n' >&2
    fi
    [ -n "$SECRET" ] || die "Secret 이 비어 있다"
    ;;
  --create)
    NAME="${2:-}"
    [ -n "$NAME" ] || die "--create <name> 이 필요하다"
    [ -n "${CF_ACCOUNT_ID:-}" ] || die "CF_ACCOUNT_ID 가 비어 있다"
    TOKEN_FILE="${CF_API_TOKEN_FILE:-}"
    [ -n "$TOKEN_FILE" ] && [ -s "$TOKEN_FILE" ] || die "CF_API_TOKEN_FILE 이 비어 있거나 파일이 없다"
    command -v jq >/dev/null || die "jq 가 필요하다"
    # 토큰은 파일에서 curl 의 -H @file 형식으로 넘긴다 — 명령줄·환경에 값이 오르지 않는다.
    HDR_FILE="$(mktemp)"; trap 'rm -f "$HDR_FILE"' EXIT
    printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" > "$HDR_FILE"
    RESP="$(curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/service_tokens" \
      -H "@${HDR_FILE}" -H 'Content-Type: application/json' \
      --data "$(jq -cn --arg n "$NAME" '{name:$n, duration:"8760h"}')")"
    if [ "$(printf '%s' "$RESP" | jq -r '.success')" != "true" ]; then
      printf '%s\n' "$RESP" | jq -r '.errors[]?.message // "unknown error"' >&2
      die "서비스 토큰 생성 실패"
    fi
    CLIENT_ID="$(printf '%s' "$RESP" | jq -r '.result.client_id')"
    SECRET="$(printf '%s' "$RESP" | jq -r '.result.client_secret')"
    [ -n "$CLIENT_ID" ] && [ -n "$SECRET" ] && [ "$SECRET" != "null" ] || die "응답에 client_id/client_secret 이 없다"
    unset RESP
    {
      echo "만들어진 서비스 토큰: $NAME (client_id=$CLIENT_ID)"
      echo "다음 두 가지를 해야 실제로 열린다:"
      echo "  1. Access 앱(dev.b3rys.com/team) 정책에 Service Auth 로 이 토큰을 넣는다."
      echo "  2. 서버 .env 의 B3OS_MCP_PRINCIPALS 에 '${CLIENT_ID}:<agent>:<read|write>' 를 추가하고 서버를 재시작한다."
    } >&2
    ;;
  *)
    die "사용법: $0 --create <name> | --format   (자세한 것은 파일 머리 주석)"
    ;;
esac

# ★연결 코드는 stdout 한 줄★ — 이 줄만 복사해 앱에 넣는다.
printf 'b3os://%s/team#%s:%s\n' "$HOST" "$CLIENT_ID" "$SECRET"
