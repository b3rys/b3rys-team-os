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
  (👀 react owner-only 는 ★이미 되어 있다★ — telegram-progress 의 `_react_owner_skip` 이
   owner 가 아니면 리액션을 건너뛴다. 이 항목은 남은 과제가 아니다.)

설치:
  ★손으로 복사하지 마라. 서버가 자동으로 깐다★ — `installOwnerGateHook`(launcher)이 멤버
  워크스페이스 `.claude/` 에 훅 파일과 `UserPromptSubmit` 배선을 넣고, 부팅 때 `ensureOwnerGateHook`
  이 없으면 새로 깐다. 커맨드에 `B3OS_ROOT`·`OWNER_GATE_SELF` 도 서버가 실어준다.

  ★전역(`~/.claude/settings.json`)에 손으로 걸지 마라.★ 멤버 스코프와 양쪽에 걸리면
  ★게이트가 두 번 돈다.★ 예전 안내가 전역 등록이었고, 그 이중 배선을 걷어낸 적이 있다.

  라이브 확인이 필요하면 ★해당 멤버★ 의 poller 를 재시작한 뒤 본다.

⚠ 설치/테스트 시 검증할 것:
  - UserPromptSubmit block 계약: 이 버전은 stdout JSON {"decision":"block"} 을 쓴다.
    설치된 Claude Code 버전에서 실제로 prompt 가 차단되는지 확인(필요시 exit 2 fallback).

ENV:
  OWNER_GATE_SELF        내 에이전트 id. ★미설정이면 TELEGRAM_STATE_DIR 에서 유추하고,
                         그것도 없으면 게이트를 끈다(폴백 없음).★ 남의 id 로 판정하면
                         게이트가 꺼지는 게 아니라 ★반대로 돌기★ 때문이다(아래 _self_id 참고).
  OWNER_GATE_GROUP       게이트할 그룹 chat_id (env 또는 $B3OS_ROOT/.env 의 TEAM_GROUP_ID).
                         ★1:1/그룹 판정 자체는 chat_id 부호로 한다★ — 이 값은 어느 방인지 표시용.
  OWNER_GATE_ROUTE_URL   라우터 결정 엔드포인트 (default: http://127.0.0.1:7878/team/api/route)
  OWNER_GATE_LOG         디버그 로그 경로 (선택)
"""
import sys
import os
import json
import re

def _self_id():
    """이 세션이 누구인가. 런처가 `OWNER_GATE_SELF` 로 실어준다.

    ★폴백이 틀리면 게이트가 꺼지는 게 아니라 반대로 돈다.★ 예전 폴백은 `"bill"` 이었는데,
    그러면 ★남의 이름으로 owner 판정을 받는다★ — 자기 앞으로 온 글에서 자기가 막히고,
    남 앞으로 온 글에는 응답한다. 진행표시 훅은 폴백이 틀리면 ★알림이 엉뚱한 방에 가서 보이지만★,
    이 훅은 ★조용히 반대로 판정한다.★ 같은 규약이어도 결과가 다르다(lui 교차검증).

    그래서 ★확실히 모르면 게이트를 끈다★ — `""` 를 돌려주면 호출부가 통과시킨다.
    남의 id 로 판정하는 것보다 ★게이트가 없는 편이 낫다.★
    """
    env = os.environ.get("OWNER_GATE_SELF")
    if env:
        return env
    sd = os.environ.get("TELEGRAM_STATE_DIR", "")
    base = os.path.basename(sd.rstrip("/"))
    if base.startswith("telegram-"):
        return base[len("telegram-"):]
    return ""


def _team_group():
    """게이트할 단톡방 chat_id. 못 구하면 "" (소스에 실 chat_id 비노출).

    우선순위: env `OWNER_GATE_GROUP` → `$B3OS_ROOT/.env` → `<훅파일>/../.env`.

    ★`B3OS_ROOT` 가 핵심이다.★ 이 훅은 저장소 밖으로 복사돼서 돈다 — 런처가
    `<멤버>/.claude/hooks/` 로 깐다. 그 자리에서 `../.env` 는 `<멤버>/.claude/.env` 라 ★없다.★
    그러면 GROUP_ID 가 "" 가 되고, 어떤 그룹 메시지든 `chat_id != ""` 라서 ★게이트가 통째로
    무력화된다★ — ★"깔았는데 안 도는" 상태는 안 깐 것보다 나쁘다★(깔렸다고 착각하니까).
    같은 구조로 진행표시 훅이 죽어 있었다(#230).
    """
    g = os.environ.get("OWNER_GATE_GROUP")
    if g:
        return g
    root = os.environ.get("B3OS_ROOT", "")
    here = os.path.dirname(os.path.abspath(__file__))
    for envp in ([os.path.join(root, ".env")] if root else []) + [os.path.join(here, "..", ".env")]:
        try:
            with open(envp) as f:
                for line in f:
                    if line.startswith("TEAM_GROUP_ID="):
                        v = line.split("=", 1)[1].strip()
                        if v:
                            return v
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
    # ★1:1 인가 그룹인가는 chat_id 부호로 가른다★ — 텔레그램은 그룹/슈퍼그룹이 음수, 1:1 이 양수다.
    #   예전에는 "설정된 GROUP_ID 와 다른가" 로 갈랐다. 그러면 ★두 번째 단톡방도 1:1 처럼 통과★ 해서
    #   방이 둘 이상인 설치(공개·다른 팀)에는 ★게이트가 아예 없는 방★ 이 생긴다.
    #   같은 저장소의 `reply-guard.py` 도 부호로 가른다 — ★두 훅의 1:1 정의를 같게 둔다.★
    #   `GROUP_ID` 는 "어느 방인지" 를 로그로 남기는 용도로만 쓴다(판정에서 뺀다).
    if not chat_id.startswith("-"):
        allow()  # 1:1 DM → 통과(DM 은 항상 owner). 라우터에 묻지도 않는다.
    mid = re.search(r'message_id="([^"]+)"', attrs)
    tg_msg_id = mid.group(1) if mid else ""

    text = text.strip()
    if not text:
        allow()

    # ★내가 누구인지 모르면 게이트를 끈다.★ 남의 id 로 물으면 판정이 반대로 나온다.
    if not SELF_ID:
        _log("self id unknown → fail-open (OWNER_GATE_SELF/TELEGRAM_STATE_DIR 미설정)")
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
