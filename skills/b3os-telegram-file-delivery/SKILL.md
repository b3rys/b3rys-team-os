---
name: b3os-telegram-file-delivery
description: "Telegram으로 파일(HTML·PDF·이미지·ZIP·문서 등)을 보내야 할 때, 막히는 message/첨부 도구 대신 Bot API sendDocument를 안전하게 쓰는 팀 정본 절차."
---

# b3rys Telegram File Delivery

Telegram으로 **파일을 그대로 보내야 할 때** 쓰는 스킬이다. 팀에서 반복되는 실수 = "텔레그램에서 파일이 안 보내진다." 원인은 런타임의 `message`/첨부 도구가 파일 직접 첨부를 보안 제한으로 막거나(특히 OpenClaw/Forin 계열 `.html`), 첨부 경로/형식이 도구 제약에 안 맞는 것이다. **해법은 일관된다 — Telegram Bot API의 `sendDocument`를 직접 호출한다.** HTML만이 아니라 PDF·이미지·ZIP·CSV·로그 등 모든 파일에 동일하게 적용된다.

## 언제 쓰나

- `message`/reply 도구로 파일 첨부가 막히거나 실패할 때 (가장 흔한 케이스).
- HTML 산출물을 ZIP으로 우회하지 않고 원본 그대로 보내고 싶을 때.
- 보고서(PDF/HTML), 스크린샷(PNG/JPG), 데이터(CSV/JSON), 압축본(ZIP) 등 어떤 파일이든 텔레그램으로 보내야 할 때.

## 원칙

- 파일 전송이 도구로 막히면 ZIP/링크로 우회하기 **전에** 이 스킬(`sendDocument`)을 먼저 쓴다.
- 외부 전송이므로 the team lead 또는 요청자의 명시 컨펌을 받은 뒤 보낸다.
- bot token(봇 토큰), chat id(채팅방 ID), credential은 env/profile에서 읽고 stdout에 노출하지 않는다.
- 성공 여부는 Telegram API 응답의 `ok`, `message_id`, 파일명만 보고한다. 토큰·전체 응답·chat id는 불필요하게 출력하지 않는다.

## 필요한 값

- `TELEGRAM_BOT_TOKEN`: 보낼 봇의 token (Hermes profile env, OpenClaw account env 등).
- `TELEGRAM_CHAT_ID`: 대상 채팅방 또는 DM id.
- 파일 경로: 실제 존재하는 파일.
- 선택 caption: 짧게.

## 파일 형식별 MIME 타입

`document=@경로;type=<mime>` 로 명시하면 텔레그램이 올바르게 인식한다. (생략해도 대개 동작하지만 HTML 등은 명시 권장.)

| 파일 | MIME |
|---|---|
| `.html` | `text/html` |
| `.pdf` | `application/pdf` |
| `.png` / `.jpg` | `image/png` / `image/jpeg` |
| `.zip` | `application/zip` |
| `.csv` | `text/csv` |
| `.json` | `application/json` |
| `.md` / `.txt` / `.log` | `text/plain` |

## 절차

1. 파일 확인
   - 파일이 존재하는지, 비어있지 않은지(`[ -s 파일 ]`) 확인한다.
   - 민감정보·로컬 절대경로·토큰·비공개 데이터가 파일 안에 들어있지 않은지 빠르게 확인한다.

2. 전송 컨펌
   - 외부 Telegram 전송이므로 보내기 전에 대상·파일명·목적을 말하고 컨펌을 받는다.
   - 사용자가 현재 thread에서 명시적으로 "보내"/"전송"을 지시했다면 그 지시를 컨펌으로 본다.

3. Bot API 호출

   직접 호출 (형식에 맞는 `type` 지정):

   ```bash
   curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument" \
     -F "chat_id=${TELEGRAM_CHAT_ID}" \
     -F "document=@/absolute/path/to/file.pdf;type=application/pdf" \
     -F "caption=report"
   ```

   또는 이 스킬의 스크립트 (확장자로 MIME 자동 추정):

   ```bash
   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... \
     bash skills/b3os-telegram-file-delivery/scripts/send-file.sh \
     /absolute/path/to/file.pdf "caption"
   ```

4. 검증
   - 응답 JSON에서 `ok: true`인지 확인한다.
   - `result.message_id`를 기록한다.
   - 실패하면 `description`만 요약하고 token/chat id는 출력하지 않는다.

## 실패 대응

- `message`/첨부 도구가 파일을 막으면 ZIP/링크로 바꾸기 전에 이 스킬을 쓴다.
- `Bad Request: chat not found`: bot이 해당 chat에 없거나 chat id가 틀린 것이다.
- `Unauthorized`: token이 틀렸거나 env가 로드되지 않았다. token 값은 출력하지 말고 env 경로만 점검한다.
- `file must be non-empty`: 파일 경로 또는 렌더/생성 결과를 확인한다.
- 사진을 "압축 없는 원본 문서"로 보내려면 `sendPhoto`가 아니라 `sendDocument`를 쓴다(화질 보존).
- 보안상 원본 전송이 부적절하면 PDF/ZIP/링크로 바꾸기 전에 요청자에게 이유를 설명하고 확인받는다.

## 팀 전파 포인트

- 런타임 `message`/첨부 도구 제한과 Telegram Bot API `sendDocument`는 **다른 전송 경로**다. 도구가 막혀도 Bot API는 된다.
- 성공 패턴 = `sendDocument` + multipart form-data + `document=@파일;type=<mime>`.
- "텔레그램에서 파일이 안 보내진다"는 반복 이슈를 만나면 우회(ZIP/링크)하기 전에 이 스킬을 먼저 확인한다.
