#!/usr/bin/env python3
"""owner-gate hook (UserPromptSubmit) — 그룹 메시지 owner 판정 게이트 [v1 draft].

배경:
  빌(claude_channel, requireMention=false)은 그룹 전체 메시지를 자기 텔레그램 봇(plugin)으로
  직접 받는다(경로 A). 이 경로엔 team-collab 라우터의 owner-gate 가 없어서, 빌이 자기 것이
  아닌 메시지(@코덱스 등)에도 "판단"으로 응답해버리는 게 반복됐다(2026-06-02 진단).
  이 hook 은 들어온 그룹 메시지를 라우터(/api/route)에 보내 owner 를 확인하고,
  빌이 owner 가 아니면 그 prompt 를 block 해서 응답 자체를 막는다(판단 의존 제거).

v1 범위 (안전 우선):
  - 그룹(OWNER_GATE_GROUP) 메시지만 게이트. 1:1 DM·비-telegram prompt 는 통과(항상 owner).
  - 확신 케이스만 block: 라우터 reason=="explicit_mention" 이고 내가 targets 에 없을 때
    (= @다른사람만 호출한 메시지. 예: "@코덱스 …" → 빌 침묵). 오늘 T2 케이스.
  - 그 외(reply_author/sticky/default_intake/broadcast/ask_gd/라우터 에러·타임아웃)는
    전부 fail-open 통과. 팀 원칙 "false-drop(무응답) > over-summon" — 불확실하면 막지 않는다.

v2 (후속):
  - reply/sticky 게이팅: 경로 A엔 reply 원문/sticky 가 없으니, 캡처가 버스에 적재한
    reply_to_agent + activeAssigneeId 를 끌어와 /api/route 에 넣어 T4(코덱스 답장→codex) 등도 차단.
  - 👀 react owner-only: 현재 telegram-progress react 가 모든 그룹 메시지에 👀 를 단다.
    owner 일 때만 달도록 react 훅과 통합 필요(이 게이트의 owner 판정 공유).

설치 (터미널 = self-mod, 채널 OK로는 분류기가 막음):
  cp hooks/telegram-owner-gate.py ~/.claude/hooks/
  ~/.claude/settings.json 의 UserPromptSubmit 에 등록(telegram-progress react 보다 먼저 권장)
  빌 poller 재시작 후 T1~T6 로 라이브 검증.

⚠ 설치/테스트 시 검증할 것:
  - UserPromptSubmit block 계약: 이 버전은 stdout JSON {"decision":"block"} 을 쓴다.
    설치된 Claude Code 버전에서 실제로 prompt 가 차단되는지 확인(필요시 exit 2 fallback).

ENV:
  OWNER_GATE_SELF        내 에이전트 id (default: bill)
  OWNER_GATE_GROUP       게이트할 그룹 chat_id (env 또는 team-collab/.env TEAM_GROUP_ID)
  OWNER_GATE_ROUTE_URL   라우터 결정 엔드포인트 (default: http://127.0.0.1:7878/team/api/route)
  OWNER_GATE_LOG         디버그 로그 경로 (선택)
"""
import sys
import os
import json
import re

def _self_id():
    # settings.json 은 claude 봇 4개(bill·steve·demis·dbak)가 공유(심링크)하므로,
    # 자기 봇 id 를 하드코딩하지 않고 TELEGRAM_STATE_DIR(예: .../telegram-bill)에서 per-bot 으로 얻는다.
    env = os.environ.get("OWNER_GATE_SELF")
    if env:
        return env
    sd = os.environ.get("TELEGRAM_STATE_DIR", "")
    base = os.path.basename(sd.rstrip("/"))
    if base.startswith("telegram-"):
        return base[len("telegram-"):]
    return "bill"


def _team_group():
    # 우선순위: env OWNER_GATE_GROUP → team-collab/.env 의 TEAM_GROUP_ID → "" (소스에 실 chat_id 비노출)
    g = os.environ.get("OWNER_GATE_GROUP")
    if g:
        return g
    try:
        envp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
        with open(envp) as f:
            for line in f:
                if line.startswith("TEAM_GROUP_ID="):
                    return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return ""


SELF_ID = _self_id()
GROUP_ID = _team_group()
ROUTE_URL = os.environ.get("OWNER_GATE_ROUTE_URL", "http://127.0.0.1:7878/team/api/route")


def _log(msg):
    path = os.environ.get("OWNER_GATE_LOG")
    if not path:
        return
    try:
        import time
        with open(path, "a") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
    except Exception:
        pass


def allow():
    # prompt 를 그대로 처리(통과). 아무 출력도 하지 않고 정상 종료.
    sys.exit(0)


def block(reason):
    # UserPromptSubmit block: 이 prompt 를 모델에 넘기지 않음 → 응답/턴 없음.
    _log(f"BLOCK {reason}")
    print(json.dumps({"decision": "block", "reason": reason}))
    sys.exit(0)


def main():
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except Exception:
        allow()
    prompt = data.get("prompt", "") or ""

    # 가장 최근 telegram <channel ...>TEXT</channel> 블록 추출
    blocks = re.findall(r"<channel\b([^>]*)>(.*?)</channel>", prompt, re.DOTALL)
    tg = [(attrs, text) for attrs, text in blocks if "telegram" in attrs]
    if not tg:
        allow()  # telegram 채널 메시지 아님(주입/일반 prompt) → 통과

    attrs, text = tg[-1]  # 가장 최근 채널 메시지
    cid = re.search(r'chat_id="([^"]+)"', attrs)
    chat_id = cid.group(1) if cid else ""
    if chat_id != GROUP_ID:
        allow()  # 1:1 DM 또는 다른 방 → 통과(DM 은 항상 owner)
    mid = re.search(r'message_id="([^"]+)"', attrs)
    tg_msg_id = mid.group(1) if mid else ""

    text = text.strip()
    if not text:
        allow()

    # thin-client: self + 원본 telegram message_id 를 보내고 서버(/api/route)의 suppress 판단만 따른다.
    # tgMessageId 로 서버가 capture 결정(reply/sticky 반영)을 조회 → reply-blindness 보완.
    # owner/suppress 룰은 전부 서버(teamRouter.shouldSuppress)에 있다 — 이 훅엔 자체 로직 없음(GD 2098).
    try:
        import urllib.request
        body = json.dumps({"text": text, "self": SELF_ID, "tgMessageId": tg_msg_id}).encode()
        req = urllib.request.Request(
            ROUTE_URL, data=body, headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=3) as r:
            decision = json.loads(r.read().decode())
    except Exception as e:
        _log(f"route error → fail-open: {e}")
        allow()  # 라우터 에러/타임아웃 → fail-open

    _log(f"text={text[:40]!r} reason={decision.get('reason')} targets={decision.get('targetAgentIds')} self={SELF_ID} suppress={decision.get('suppress')}")
    if decision.get("suppress"):
        block(f"owner-gate: server suppress (reason={decision.get('reason')}, targets={decision.get('targetAgentIds')}, not {SELF_ID})")

    allow()  # suppress 아니면 통과(fail-open 포함)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # 어떤 에러도 prompt 를 막지 않는다(절대 fail-closed 금지).
        sys.exit(0)
