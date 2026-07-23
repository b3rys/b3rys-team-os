#!/usr/bin/env python3
"""reply-guard — Stop hook (claude_channel 팀원 워크스페이스 .claude/settings.json 에 설치).

문제: Claude 런타임 팀원이 1:1 텔레그램 DM에 최종 답을 작업창(transcript)에만 쓰고
      reply 도구 호출을 빠뜨림 → 상대에게 미도달. 페르소나 규칙으로도 짧은 답 흐름에서 반복 누락.
근본: Claude 는 "답 생성 = 전송"이 아님. 채널 도달은 reply 툴콜만 유효. 정적 규칙으론 못 막는
      마지막 send 누락을 하네스(Stop 훅)가 잡는다.

동작: 턴 종료 시 —
  · 그 턴의 트리거가 1:1 텔레그램 DM(<channel source="plugin:telegram">) 이고
  · 그 이후 reply / edit_message 툴콜이 0회면
  → block + "지금 reply 로 보내라" 재프롬프트(모델이 한 턴 더 돌며 실제 전송).

스코프/안전:
  · **1:1 DM 만** — 그룹(external_message)은 팀원이 owner 아니면 정당하게 침묵하므로 관여 안 함(false-block 방지).
  · react/편집만으론 '답'이 아님 → reply·edit_message 만 send 로 인정.
  · 무한루프 방지: 같은 턴 최대 2회만 block(그 뒤엔 통과 — 유실 감수하되 세션 안 막음).
  · 어떤 에러도 턴을 막지 않는다(항상 allow=exit0).
"""
import sys, json, os


def allow():
    # 출력 없이 exit0 = Stop 허용(정상 종료).
    sys.exit(0)


def block(reason):
    print(json.dumps({"decision": "block", "reason": reason}))
    sys.exit(0)


def _text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            b.get("text", "") for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return ""


def _has_tool_result(content):
    return isinstance(content, list) and any(
        isinstance(b, dict) and b.get("type") == "tool_result" for b in content
    )


def _reply_or_edit_toolcall(content):
    if not isinstance(content, list):
        return False
    for b in content:
        if isinstance(b, dict) and b.get("type") == "tool_use":
            name = b.get("name", "") or ""
            if ("telegram" in name and "reply" in name) or "edit_message" in name:
                return True
    return False


def main():
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except Exception:
        return allow()
    tp = data.get("transcript_path")
    if not tp or not os.path.exists(tp):
        return allow()
    try:
        lines = open(tp, encoding="utf-8").read().splitlines()
    except Exception:
        return allow()

    # 1) 마지막 '실제 user 입력'(tool_result 제외) 위치·텍스트.
    last_user_idx = None
    last_user_text = ""
    for i in range(len(lines) - 1, -1, -1):
        try:
            ev = json.loads(lines[i])
        except Exception:
            continue
        msg = ev.get("message", {}) or {}
        if ev.get("type") == "user" or msg.get("role") == "user":
            content = msg.get("content", "")
            if _has_tool_result(content):
                continue  # 도구 결과(내부) — 트리거 아님
            last_user_idx = i
            last_user_text = _text_of(content)
            break
    if last_user_idx is None:
        return allow()

    # 2) 1:1 텔레그램 DM 턴인가? (그룹 external_message 는 owner 아니면 침묵이 정상 → 관여 안 함)
    if '<channel source="plugin:telegram' not in last_user_text:
        return allow()

    # 3) 이 턴에 reply/edit_message 툴콜이 있었나?
    for i in range(last_user_idx + 1, len(lines)):
        try:
            ev = json.loads(lines[i])
        except Exception:
            continue
        msg = ev.get("message", {}) or {}
        if _reply_or_edit_toolcall(msg.get("content", "")):
            return allow()  # 보냄 → OK

    # 4) 무한루프 방지 — 같은 턴 최대 2회 block.
    try:
        turn_key = json.loads(lines[last_user_idx]).get("uuid") or str(last_user_idx)
    except Exception:
        turn_key = str(last_user_idx)
    state_path = os.path.join(os.path.dirname(os.path.abspath(tp)), ".reply-guard-state.json")
    try:
        st = json.load(open(state_path))
        if not isinstance(st, dict):
            st = {}
    except Exception:
        st = {}
    n = int(st.get(turn_key, 0)) if str(st.get(turn_key, 0)).isdigit() else 0
    if n >= 2:
        return allow()  # 2회 경고에도 안 보냄 → 무한루프 방지로 통과
    try:
        json.dump({turn_key: n + 1}, open(state_path, "w"))  # 최근 턴만 유지
    except Exception:
        pass

    block(
        "⚠️ 이번 턴에 텔레그램 1:1 메시지를 받았는데 아직 reply 도구로 답을 보내지 않았습니다. "
        "작업 화면(transcript)에 쓴 글은 상대에게 도달하지 않아요 — 지금 "
        "`mcp__plugin_telegram_telegram__reply` 도구를 호출해서 답을 실제로 전송하세요. "
        "(답할 내용이 없다면 이 경고는 곧 사라집니다.)"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(0)
