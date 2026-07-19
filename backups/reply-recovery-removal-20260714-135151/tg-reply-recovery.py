#!/usr/bin/env python3
"""tg-reply-recovery.py — Stop hook. 깨진 telegram reply 도구호출 자동 복구 전송.

문제: Claude 가 `mcp__plugin_telegram_telegram__reply` 도구호출을 잘못된 형식(antml 대신
  평문 <invoke>...)으로 생성하면 하네스가 파싱 못 해 = 메시지 미전송 + 마크업 채팅 누수.
  "재시도 유도"(block)는 모델이 또 틀리면 또 깨짐 → 모델 판단에 의존.

해법(OWNER 2026-06-30 "기계적 강제"): 깨진 마크업을 감지하면 그 안의 chat_id+본문을 추출해
  훅이 **직접** 텔레그램으로 전송한다(tg-send.sh 재사용 — 토큰/청킹/plain-text 처리됨).
  = 모델이 형식을 틀려도 메시지는 기계가 보낸다. 모델 신뢰성이 루프에서 빠진다.

토큰: 훅은 토큰값을 안 본다. TG_SEND_ENV 파일(OWNER가 채움)에서 tg-send.sh 가 읽는다.
  토큰 파일 없으면 → 옛 동작(재시도 유도 block)으로 안전 폴백.

안전장치:
  - stop_hook_active 면 재차단/재전송 안 함(루프 방지)
  - dedup: 이미 보낸 (chat_id+본문) 해시는 재전송 안 함(Stop 반복 호출 대비)
  - DRYRUN(TG_RECOVERY_DRYRUN=1): 실제 전송 대신 무엇을 보낼지만 출력(테스트용)
  - 전송 성공 = exit 0(조용히 종료, 모델이 또 보내지 않게). 토큰X/전송실패 = block 폴백.
"""
import json
import os
import re
import sys
import hashlib
import subprocess
import tempfile

HOME = os.path.expanduser("~")
TOKEN_ENV = os.environ.get("TG_RECOVERY_ENV", f"{HOME}/.claude/hooks/tg-recovery.env")
STATE_PATH = os.environ.get("TG_RECOVERY_STATE", f"{HOME}/.claude/hooks/.tg-recovery-state.json")
LOG_PATH = f"{HOME}/.claude/hooks/.tg-recovery.log"
DRYRUN = os.environ.get("TG_RECOVERY_DRYRUN", "") == "1"
# tg-send.sh 경로(존재하는 첫 후보)
TG_SEND_CANDIDATES = [
    os.environ.get("TG_SEND_SCRIPT", ""),
    f"{HOME}/Development/b3rys-team-os/scripts/tg-send.sh",
]

# (?:antml:)? — antml prefix 유무·bare 태그 모두 매칭(2026-07-06 Steve). 팀원 malform이
# 'antml:' 없이 bare <invoke>/<parameter>로 새는 케이스까지 추출. 기존 bare 매칭도 그대로 유지(additive).
REPLY_BLOCK = re.compile(
    r'<(?:antml:)?invoke\s+name="mcp__plugin_telegram_telegram__reply">([\s\S]*?)</(?:antml:)?invoke>'
)
PARAM_CHAT = re.compile(r'<(?:antml:)?parameter\s+name="chat_id">([\s\S]*?)</(?:antml:)?parameter>')
PARAM_TEXT = re.compile(r'<(?:antml:)?parameter\s+name="text">([\s\S]*?)</(?:antml:)?parameter>')

# reply 가 아닌 '일반 깨진 도구호출' 누수 — 직접 복구는 못 하니 재시도 유도(기존 가드 대체).
GENERIC_LEAK = [
    re.compile(r'<(?:antml:)?invoke\s+name="mcp__[^"]+">[\s\S]{0,4000}?</(?:antml:)?invoke>'),
    re.compile(r'(?m)^\s*(?:call|court)\s*\n\s*<(?:antml:)?invoke\s+name='),
    re.compile(r'<(?:antml:)?invoke\s+name="mcp__[^"]+">[\s\S]{0,4000}?<(?:antml:)?parameter\s+name='),
]


def log(msg):
    try:
        with open(LOG_PATH, "a") as f:
            f.write(msg + "\n")
    except Exception:
        pass


def last_assistant_text(tp):
    try:
        with open(tp) as f:
            lines = f.readlines()
    except Exception:
        return ""
    for ln in reversed(lines):
        try:
            ev = json.loads(ln)
        except Exception:
            continue
        msg = ev.get("message", {}) or {}
        if ev.get("type") == "assistant" or msg.get("role") == "assistant":
            c = msg.get("content", "")
            if isinstance(c, list):
                return "".join(
                    x.get("text", "") for x in c
                    if isinstance(x, dict) and x.get("type") == "text"
                )
            return str(c)
    return ""


def load_state():
    try:
        return set(json.load(open(STATE_PATH)))
    except Exception:
        return set()


def save_state(s):
    try:
        # 최근 50개만 유지
        lst = list(s)[-50:]
        json.dump(lst, open(STATE_PATH, "w"))
    except Exception:
        pass


def extract_last_reply(text):
    """마지막 깨진 reply 블록에서 (chat_id, body) 추출. 없으면 None."""
    blocks = REPLY_BLOCK.findall(text)
    if not blocks:
        return None
    inner = blocks[-1]
    mt = PARAM_TEXT.search(inner)
    mc = PARAM_CHAT.search(inner)
    if not mt or not mc:
        return None
    chat_id = mc.group(1).strip()
    body = mt.group(1)
    if not chat_id or not body.strip():
        return None
    return chat_id, body


def tg_send_script():
    for p in TG_SEND_CANDIDATES:
        if p and os.path.isfile(p):
            return p
    return None


def block(reason):
    print(json.dumps({"decision": "block", "reason": reason}))
    sys.exit(0)


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    if data.get("stop_hook_active"):
        sys.exit(0)
    tp = data.get("transcript_path")
    if not tp:
        sys.exit(0)

    text = last_assistant_text(tp)
    if not text:
        sys.exit(0)
    found = extract_last_reply(text)
    if not found:
        # reply 복구 대상은 아니지만, 다른 깨진 도구호출 누수면 재시도 유도(기존 가드 역할).
        if any(p.search(text) for p in GENERIC_LEAK):
            block(
                "통신 가드: 깨진 도구호출 마크업(<invoke>...)이 텍스트로 남았습니다(=미전송). "
                "같은 내용을 올바른 antml:invoke 형식 도구호출로 다시 보내세요."
            )
        sys.exit(0)  # 누수 없음 → 통과
    chat_id, body = found

    key = hashlib.sha1((chat_id + "\n" + body).encode("utf-8")).hexdigest()
    state = load_state()
    if key in state:
        sys.exit(0)  # 이미 복구 전송함

    # 토큰 파일 없으면 옛 동작(재시도 유도)으로 안전 폴백
    has_token = os.path.isfile(TOKEN_ENV)
    if DRYRUN:
        log(f"[DRYRUN] would send chat_id={chat_id} bodylen={len(body)}")
        print(f"[DRYRUN] recovery would send → chat_id={chat_id}, bodylen={len(body)} chars")
        state.add(key); save_state(state)
        sys.exit(0)
    if not has_token:
        block(
            "통신 가드: 깨진 telegram reply 마크업이 감지됐고(=미전송), 복구 전송 토큰 파일이 "
            f"없습니다({TOKEN_ENV}). 같은 내용을 올바른 antml:invoke reply 호출로 다시 보내세요."
        )

    script = tg_send_script()
    if not script:
        block("통신 가드: 깨진 reply 감지됐으나 tg-send.sh 를 못 찾음. antml 형식으로 다시 보내세요.")

    # 본문을 임시파일로(도구호출 JSON 안 거침 — 안전). tg-send.sh 가 토큰·청킹 처리.
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as tf:
            tf.write(body)
            body_file = tf.name
    except Exception as e:
        block(f"통신 가드: 복구 본문 임시저장 실패({e}). antml 형식으로 다시 보내세요.")

    env = dict(os.environ, TG_SEND_ENV=TOKEN_ENV)
    try:
        r = subprocess.run(
            ["bash", script, chat_id, body_file],
            env=env, capture_output=True, text=True, timeout=30,
        )
    except Exception as e:
        log(f"[ERR] tg-send spawn fail: {e}")
        block(f"통신 가드: 복구 전송 실행 실패({e}). antml 형식으로 다시 보내세요.")
    finally:
        try:
            os.unlink(body_file)
        except Exception:
            pass

    if r.returncode == 0:
        log(f"[OK] recovery sent chat_id={chat_id} bodylen={len(body)} :: {r.stdout.strip()[-200:]}")
        state.add(key); save_state(state)
        sys.exit(0)  # 전송 완료 → 조용히 종료(재전송 안 유도)
    else:
        log(f"[FAIL] rc={r.returncode} err={r.stderr.strip()[-200:]}")
        block(
            "통신 가드: 깨진 reply 자동 복구 전송이 실패했습니다. "
            "같은 내용을 올바른 antml:invoke reply 호출로 다시 보내세요."
        )


if __name__ == "__main__":
    main()
