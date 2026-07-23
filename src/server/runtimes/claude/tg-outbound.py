#!/usr/bin/env python3
"""tg-outbound.py — Tier2 always-on telegram outbound Stop hook.

Tier2 근본(malform 원천 제거): claude_channel 멤버가 GD/팀에 보내는 답을 도구호출(취약 XML)
  대신 마커 평문으로 쓰면, 이 훅이 transcript에서 추출→tg-send.sh 직접 전송한다.
  LLM 도구호출 0 = malform 원천 0. tg-reply-recovery.py(깨졌을 때만 동작)를 '항상 동작'으로 일반화.

마커: ‹‹‹b3os-send to=<chat_id>›››\n<본문>\n‹‹‹b3os-end›››   (persona가 이 형식으로 쓰게 강제 — Steve 담당)

배타 로직(결과기반, 이중전송/누락 방지):
  1. 이번 턴에 well-formed reply 도구가 실제 전송됨(transcript tool_result에 전송 확정) → skip. 도구가 이미 보냄.
  2. 마커 있음 → 마커 본문 추출·전송.
  3. 마커 없고 malform reply 마크업 → 추출 복구(recovery 안전망).
  4. 아무것도 없음 → GENERIC_LEAK면 재프롬프트 block, 아니면 통과(shadow가 '마커없는 최종텍스트가 답인 빈도' 측정 → fallback 정책 확정).
  각 전송 경로는 sha1(chat_id+body) dedupe 공유 backstop(Stop 반복 호출·경로 간 중복 차단).

전송: tg-send.sh(토큰·청킹·평문 처리) + 2~3회 backoff 재시도(transient 429/5xx 유실 방지).
DRYRUN(TG_OUTBOUND_DRYRUN=1): Phase0 shadow — 무엇을 보낼지 로그만, 실전송 X.
토큰: 훅은 토큰값을 안 본다. tg-send.sh 가 TG_SEND_ENV 파일에서 읽는다. 토큰 없으면 안전 폴백.
"""
import json
import os
import re
import sys
import time
import hashlib
import subprocess
import tempfile

HOME = os.path.expanduser("~")
TOKEN_ENV = os.environ.get("TG_OUTBOUND_ENV", os.environ.get("TG_RECOVERY_ENV", f"{HOME}/.claude/hooks/tg-recovery.env"))
STATE_PATH = os.environ.get("TG_OUTBOUND_STATE", f"{HOME}/.claude/hooks/.tg-outbound-state.json")
LOG_PATH = os.environ.get("TG_OUTBOUND_LOG", f"{HOME}/.claude/hooks/.tg-outbound.log")
DRYRUN = os.environ.get("TG_OUTBOUND_DRYRUN", "") == "1"
RETRIES = int(os.environ.get("TG_OUTBOUND_RETRIES", "3"))
TG_SEND_CANDIDATES = [
    os.environ.get("TG_SEND_SCRIPT", ""),
    f"{HOME}/Development/b3rys-team-os/scripts/tg-send.sh",
]

# 마커 — persona가 답을 이 형식으로만 쓰게 강제. ★to= 옵션(Steve ②)★ + ★delimiter 충돌 완화(GD 리스크8)★:
#   단일: ‹‹‹b3os-send›››본문‹‹‹b3os-end››› (대부분, 훅이 트리거 chat_id 자동) / 멀티·특정: ‹‹‹b3os-send to=<chat_id>›››본문‹‹‹b3os-end›››
#   ★충돌: 답 내용에 마커가 그대로 들어가면(마커 설명·코드) 잘림. → 단일은 최외곽 매칭(첫 SEND~마지막 END, inner 무시).★
SEND_OPEN = re.compile(r'‹‹‹b3os-send(?:\s+to=([0-9-]+))?›››')
END_MARK = "‹‹‹b3os-end›››"
# malform reply 안전망(recovery) — antml prefix 유무 모두.
REPLY_BLOCK = re.compile(r'<(?:antml:)?invoke\s+name="mcp__plugin_telegram_telegram__reply">([\s\S]*?)</(?:antml:)?invoke>')
PARAM_CHAT = re.compile(r'<(?:antml:)?parameter\s+name="chat_id">([\s\S]*?)</(?:antml:)?parameter>')
PARAM_TEXT = re.compile(r'<(?:antml:)?parameter\s+name="text">([\s\S]*?)</(?:antml:)?parameter>')
GENERIC_LEAK = [
    re.compile(r'<(?:antml:)?invoke\s+name="mcp__[^"]+">[\s\S]{0,4000}?</(?:antml:)?invoke>'),
    re.compile(r'(?m)^\s*(?:call|court)\s*\n\s*<(?:antml:)?invoke\s+name='),
]


def log(msg):
    try:
        with open(LOG_PATH, "a") as f:
            f.write(msg + "\n")
    except Exception:
        pass


def _agent_id():
    """공유 로그 attribution — TG_OUTBOUND_ENV 경로(~/.claude/channels/telegram-<id>/.env)에서 멤버 id 추출.
    steve/bill이 같은 유저 HOME의 로그를 공유하므로 [SHADOW-OBS agent=<id>]로 누가 남긴 관찰인지 정확히."""
    m = re.search(r'/telegram-([a-z0-9_-]+)/', TOKEN_ENV)
    return m.group(1) if m else "?"


def _transcript_lines(tp):
    try:
        with open(tp) as f:
            return f.readlines()
    except Exception:
        return []


def last_assistant_text(lines):
    """가장 최근 assistant 메시지의 text 블록(마커·마크업이 여기 남음)."""
    for ln in reversed(lines):
        try:
            ev = json.loads(ln)
        except Exception:
            continue
        msg = ev.get("message", {}) or {}
        if ev.get("type") == "assistant" or msg.get("role") == "assistant":
            c = msg.get("content", "")
            if isinstance(c, list):
                return "".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
            return str(c)
    return ""


# 실제 telegram 전송 도구만 (tool_result가 '전송 성공'인지 판정할 때, 이 도구의 result만 카운트).
REPLY_TOOL_NAMES = ("mcp__plugin_telegram_telegram__reply",)


def _tool_use_names(lines):
    """tool_use_id → tool name 맵. tool_result가 ★어느 도구에서 왔는지★ 상관해, reply 도구 result만
    '전송 성공'으로 세기 위함(HIGH fix: Bash/Read/team.db 결과의 'sent/message_id' 오탐→답 유실 방지)."""
    m = {}
    for ln in lines:
        try:
            ev = json.loads(ln)
        except Exception:
            continue
        content = (ev.get("message", {}) or {}).get("content", "")
        if isinstance(content, list):
            for blk in content:
                if isinstance(blk, dict) and blk.get("type") == "tool_use" and blk.get("id"):
                    m[blk["id"]] = blk.get("name", "")
    return m


def last_reply_tool_text(lines):
    """shadow #1 측정용: 이번 턴에 mcp reply 도구가 실제 보낸 답(input.text).
    persona normal 멤버는 답을 text 블록이 아니라 ★reply tool_use 인자★에 넣으므로 transcript text 블록은
    비어있다(0자). 이게 '마커모드였다면 전송했을 실제 답'이라 #1(말 유실 없나) 대조의 정본."""
    for ln in reversed(lines):
        try:
            ev = json.loads(ln)
        except Exception:
            continue
        content = (ev.get("message", {}) or {}).get("content", "")
        if isinstance(content, list):
            for blk in content:
                if (isinstance(blk, dict) and blk.get("type") == "tool_use"
                        and blk.get("name") in REPLY_TOOL_NAMES):
                    t = (blk.get("input", {}) or {}).get("text", "")
                    if t:
                        return str(t)
    return ""


def wellformed_reply_sent(lines):
    """★결과기반 판정★: ★이번 턴★에 mcp reply 도구가 실제 전송에 성공했나.
    마크업 존재가 아니라 '실제 전송 tool_result(sent/message_id)'로 판정 → drop·double-send 둘 다 차단.
    ★도구 상관(HIGH fix): tool_use_id→name 으로 reply 도구의 result일 때만 카운트★ — 다른 도구(Bash·Read·
    team.db 조회) 출력에 'sent/message_id/(id:N)'가 있어도 오탐하지 않음(오탐 시 마커 skip=답 유실).
    ★턴 경계(Steve 리뷰 ①): 마지막 '순수 user 입력'(tool_result만 있는 게 아닌 실제 인바운드) 이후로만 검색★ —
    연속 턴에서 이전 턴의 sent result를 이번 턴으로 오인(double-skip) 방지."""
    id2name = _tool_use_names(lines)
    for ln in reversed(lines):
        try:
            ev = json.loads(ln)
        except Exception:
            continue
        msg = ev.get("message", {}) or {}
        role = msg.get("role")
        content = msg.get("content", "")
        blocks = content if isinstance(content, list) else []
        # 이번 턴 범위 내 reply 도구 성공 result 탐색.
        for blk in blocks:
            if isinstance(blk, dict) and blk.get("type") == "tool_result" and not blk.get("is_error"):
                # ★도구 상관(HIGH fix): 이 result가 reply 도구에서 온 게 아니면 무시★ (Bash·team.db 등 오탐 방지)
                if id2name.get(blk.get("tool_use_id", ""), "") not in REPLY_TOOL_NAMES:
                    continue
                txt = blk.get("content", "")
                if isinstance(txt, list):
                    txt = "".join(x.get("text", "") for x in txt if isinstance(x, dict))
                if re.search(r'\bsent\b|"?message_id"?|\(id:\s*\d+\)', str(txt), re.I):
                    return True
        # 순수 user 입력(tool_result 아닌 실제 인바운드)에 도달 = 이번 턴 시작 → 더 과거는 이전 턴, 중단.
        if role == "user":
            has_tool_result = any(isinstance(b, dict) and b.get("type") == "tool_result" for b in blocks)
            has_text = (isinstance(content, str) and content.strip()) or \
                       any(isinstance(b, dict) and b.get("type") == "text" for b in blocks)
            if has_text and not has_tool_result:
                break
    return False


def trigger_chat_id(lines):
    """마커에 to= 없을 때 = 마지막 인바운드에서 chat_id 자동 추출(Steve 리뷰 ②, LLM이 chat_id 복사 부담·오타 제거).
    DM=<channel ... chat_id="N"> / 그룹=<external_message ... thread="tg-<N>">(tg- 제거)."""
    for ln in reversed(lines):
        try:
            ev = json.loads(ln)
        except Exception:
            continue
        msg = ev.get("message", {}) or {}
        if msg.get("role") != "user":
            continue
        content = msg.get("content", "")
        txt = content if isinstance(content, str) else \
            "".join(x.get("text", "") for x in content if isinstance(x, dict) and x.get("type") == "text")
        m = re.search(r'<channel[^>]*\bchat_id="(-?\d+)"', txt)
        if m:
            return m.group(1)
        m = re.search(r'<external_message[^>]*\bthread="tg-(-?\d+)"', txt)
        if m:
            return m.group(1)
    return None


def _resolve_chat(explicit, lines, trig_cache):
    chat = (explicit or "").strip()
    if not chat:
        if trig_cache[0] is None:
            trig_cache[0] = trigger_chat_id(lines) or ""
        chat = trig_cache[0]
    return chat


def _trim_marker_body(raw):
    """마커↔본문 경계의 개행/공백만 최소 제거 — ★내용 공백은 보존(char-for-char 유지, GD 말유실0).★
    persona가 ‹‹‹b3os-send›››\n<본문>\n‹‹‹b3os-end››› 처럼 개행을 넣으므로 경계 개행 1개만 트림.
    .strip() 전체 트림은 본문 끝/앞의 의미있는 공백(긴 답 trailing space)까지 지워 1글자 손실 유발."""
    b = raw
    if b.startswith("\r\n"): b = b[2:]
    elif b[:1] in ("\n", "\r"): b = b[1:]
    if b.endswith("\r\n"): b = b[:-2]
    elif b[-1:] in ("\n", "\r"): b = b[:-1]
    return b


def extract_marker(text, lines):
    """마커 블록 추출 → [(chat_id, body), ...]. to= 없으면 트리거 chat_id 자동.
    ★단일 SEND = 최외곽(첫 SEND~마지막 END): 답 내용에 마커가 들어가도 안 잘림(GD 리스크8 완화).★
    ★멀티 SEND = 각 SEND~다음 END(non-greedy). 멀티에 inner 마커 있으면 오분할 가능 → 로그(Phase0 충돌빈도 측정).★"""
    opens = list(SEND_OPEN.finditer(text))
    if not opens:
        return []
    ends = [m.start() for m in re.finditer(re.escape(END_MARK), text)]
    if not ends:
        return []
    out = []
    trig_cache = [None]
    # ★단일/멀티 판정 = 순차 페어링★(MED fix: 같은 chat 2블록도 각각 전송, 마커누출 방지):
    # 각 SEND를 그 뒤 첫 END에 매칭. 페어 2+가 서로 안 겹치면(non-overlapping) 진짜 멀티블록(to= 무관).
    # 겹치거나 nested(본문에 마커 든 경우)면 → 최외곽 단일(내용 안 잘림).
    pairs = []
    used = -1
    for o in opens:
        after = [e for e in ends if e >= o.end() and e > used]
        if after:
            pairs.append((o, after[0]))
            used = after[0]
    non_overlap = len(pairs) >= 2 and all(pairs[i][1] <= pairs[i + 1][0].start() for i in range(len(pairs) - 1))
    if non_overlap:
        # 깨끗한 멀티블록: 각 SEND~그 END 개별 전송(같은 chat이어도 각각, 마커 누출 없음).
        for o, e in pairs:
            body = _trim_marker_body(text[o.end():e])
            chat = _resolve_chat(o.group(1), lines, trig_cache)
            if chat and body:
                out.append((chat, body))
    else:
        # ★단일(대부분·메타충돌 포함): 첫 SEND ~ 마지막 END = 최외곽. 답 내용에 마커가 들어가도 안 잘림.★
        first = opens[0]
        last_end = ends[-1]
        if last_end >= first.end():
            body = _trim_marker_body(text[first.end():last_end])
            chat = _resolve_chat(first.group(1), lines, trig_cache)
            if chat and body:
                out.append((chat, body))
                if ("‹‹‹b3os-send" in body) or (END_MARK in body):
                    log(f"[COLLISION] body contains marker text — outermost로 처리(안 잘림) bodylen={len(body)}")
    return out


def extract_malform_reply(text):
    """마커 없을 때 안전망 — 깨진 reply 마크업에서 (chat_id, body)."""
    blocks = REPLY_BLOCK.findall(text)
    if not blocks:
        return None
    inner = blocks[-1]
    mt = PARAM_TEXT.search(inner)
    mc = PARAM_CHAT.search(inner)
    if not mt or not mc:
        return None
    chat_id, body = mc.group(1).strip(), mt.group(1)
    if not chat_id or not body.strip():
        return None
    return chat_id, body


def load_state():
    try:
        return set(json.load(open(STATE_PATH)))
    except Exception:
        return set()


def save_state(s):
    try:
        json.dump(list(s)[-100:], open(STATE_PATH, "w"))
    except Exception:
        pass


def tg_send_script():
    for p in TG_SEND_CANDIDATES:
        if p and os.path.isfile(p):
            return p
    return None


def send_via_tg(chat_id, body):
    """tg-send.sh 1회 호출. ★transient 재시도는 tg-send.sh가 per-chunk로 처리★(성공 청크 재전송 방지).
    여기서 감싸 재시도하면 멀티청크 부분실패 시 성공 청크를 중복 전송하므로 단일 호출만. 성공 True."""
    script = tg_send_script()
    if not script:
        log("[ERR] tg-send.sh not found")
        return False
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as tf:
            tf.write(body)
            body_file = tf.name
    except Exception as e:
        log(f"[ERR] tmp write fail: {e}")
        return False
    env = dict(os.environ, TG_SEND_ENV=TOKEN_ENV, TG_SEND_RETRIES=str(RETRIES))
    try:
        r = subprocess.run(["bash", script, chat_id, body_file], env=env,
                           capture_output=True, text=True, timeout=90)  # per-chunk 재시도 여유
    except Exception as e:
        log(f"[ERR] spawn fail: {e}")
        return False
    finally:
        try:
            os.unlink(body_file)
        except Exception:
            pass
    if r.returncode == 0:
        log(f"[OK] sent chat_id={chat_id} bodylen={len(body)} :: {r.stdout.strip()[-160:]}")
        return True
    log(f"[FAIL] chat_id={chat_id} rc={r.returncode} err={r.stderr.strip()[-160:]}")
    return False


def deliver(chat_id, body, state):
    key = hashlib.sha1((chat_id + "\n" + body).encode("utf-8")).hexdigest()
    if key in state:
        return True  # 이미 보냄(경로 간·Stop 반복 dedupe)
    if DRYRUN:
        log(f"[DRYRUN] would send chat_id={chat_id} bodylen={len(body)} :: {body[:80]!r}")
        print(f"[DRYRUN] tg-outbound would send → chat_id={chat_id}, {len(body)} chars")
        state.add(key)
        return True
    if send_via_tg(chat_id, body):
        state.add(key)
        return True
    return False


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
    lines = _transcript_lines(tp)
    if not lines:
        sys.exit(0)

    # ① 결과기반: 이번 턴 well-formed reply가 실제 전송됨 → 훅은 아무것도 안 함(도구가 보냄).
    if wellformed_reply_sent(lines):
        # ★shadow 관찰(DRYRUN): 정상 skip을 측정 데이터로 남긴다★ — persona normal 멤버는 reply 도구로
        # 답하므로 여기서 조용히 exit하면 #1(마커모드였다면 전송했을 최종텍스트)·#3(배타=이중전송 방지)이 안 남는다.
        # 실전송은 여전히 0(로그만). live(비-DRYRUN)에선 조용히 skip(관찰 불필요).
        if DRYRUN:
            # ★#1 정본 = reply 도구 인자 텍스트(=실제 GD한테 간 답)★. persona normal은 답이 text 블록이
            # 아니라 reply tool_use 인자에 있어 last_assistant_text는 0자 → last_reply_tool_text로 실제 답을 잡는다.
            _cand = last_reply_tool_text(lines) or last_assistant_text(lines) or ""
            _src = "reply인자" if last_reply_tool_text(lines) else "text블록"
            # ★Phase1 char-for-char 대조용: full-text sha256(프리뷰 truncate 한계 해결) + agent-id 태그(공유 로그 attribution).★
            _h = hashlib.sha256(_cand.encode("utf-8")).hexdigest()[:16]
            _aid = _agent_id()
            log(f"[SHADOW-OBS agent={_aid}] wellformed reply 도구 전송 감지 → skip(배타 정상·이중전송 방지). "
                f"실제 전송답({_src}) {len(_cand)}자 sha256={_h} :: {_cand[:160]!r}  "
                f"(마커모드였다면 이게 전송 후보=말 유실 없음 대조용; Phase1서 추출결과 해시와 대조)")
        sys.exit(0)

    text = last_assistant_text(lines)
    if not text:
        sys.exit(0)
    state = load_state()

    # ② 마커 = Tier2 정본 경로.
    markers = extract_marker(text, lines)
    if markers:
        all_ok = True
        for chat_id, body in markers:
            if not deliver(chat_id, body, state):
                all_ok = False
        save_state(state)
        if all_ok:
            sys.exit(0)
        block("통신 가드: tg-outbound 마커 전송 실패(transient). 잠시 후 같은 답을 마커로 다시 보내세요.")

    # ③ 마커 없음 + malform reply 마크업 → 안전망 복구.
    found = extract_malform_reply(text)
    if found:
        chat_id, body = found
        ok = deliver(chat_id, body, state)
        save_state(state)
        if ok:
            sys.exit(0)
        block("통신 가드: 깨진 reply 복구 전송 실패. 같은 답을 마커(‹‹‹b3os-send to=…›››…‹‹‹b3os-end›››)로 다시 보내세요.")

    # ④ 마커도 마크업도 없음. GENERIC_LEAK(다른 깨진 도구호출)면 재프롬프트, 아니면 통과.
    #    (Phase0 shadow: '마커 없는 최종 텍스트가 실제 답인 빈도'를 여기서 측정 → fallback 정책 데이터로 확정.)
    if any(p.search(text) for p in GENERIC_LEAK):
        block("통신 가드: 깨진 도구호출 마크업이 텍스트에 남았습니다(=미전송). 답이면 마커(‹‹‹b3os-send to=…›››…‹‹‹b3os-end›››)로 다시 보내세요.")
    else:
        log(f"[SHADOW] no marker/markup — final text {len(text)} chars :: {text[:120]!r}")
    sys.exit(0)


if __name__ == "__main__":
    # ★전역 fail-safe(MED fix): 미포착 예외가 나도 멤버 턴을 깨지 않고 exit0.★ 답 유실 가능성은
    # 진단용 로그로 남긴다(전송실패는 각 경로에서 block()으로 이미 재프롬프트). Stop 훅이 크래시로
    # 멤버 동작을 막는 일이 없게.
    try:
        main()
    except SystemExit:
        raise
    except Exception as _e:
        try:
            log(f"[ERROR] tg-outbound 미포착 예외 — fail-safe exit0: {type(_e).__name__}: {_e}")
        except Exception:
            pass
        sys.exit(0)
