#!/usr/bin/env bash
# b3rys Telegram File Delivery — 막히는 message/첨부 도구 대신 Bot API sendDocument로 파일 전송.
# 확장자로 MIME 자동 추정. HTML·PDF·이미지·ZIP·CSV·JSON·텍스트 등 모든 파일 지원.
# 사용: TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... send-file.sh /path/to/file [caption]
set -euo pipefail

file="${1:-}"
caption="${2:-}"

if [[ -z "$file" ]]; then
  echo "usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... $0 /path/to/file [caption]" >&2
  exit 2
fi

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
  echo "missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID" >&2
  exit 2
fi

if [[ ! -f "$file" ]]; then
  echo "file not found: $file" >&2
  exit 2
fi

if [[ ! -s "$file" ]]; then
  echo "file is empty: $file" >&2
  exit 2
fi

# 확장자 → MIME 추정 (없으면 octet-stream 으로 보냄)
ext="${file##*.}"
case "$(echo "$ext" | tr '[:upper:]' '[:lower:]')" in
  html|htm) mime="text/html" ;;
  pdf)      mime="application/pdf" ;;
  png)      mime="image/png" ;;
  jpg|jpeg) mime="image/jpeg" ;;
  gif)      mime="image/gif" ;;
  webp)     mime="image/webp" ;;
  svg)      mime="image/svg+xml" ;;
  zip)      mime="application/zip" ;;
  csv)      mime="text/csv" ;;
  json)     mime="application/json" ;;
  md|txt|log) mime="text/plain" ;;
  *)        mime="application/octet-stream" ;;
esac

[[ -z "$caption" ]] && caption="$(basename "$file")"

curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument" \
  -F "chat_id=${TELEGRAM_CHAT_ID}" \
  -F "document=@${file};type=${mime}" \
  -F "caption=${caption}"
