#!/usr/bin/env python3
"""Telegram 라이브 진행표시 — 통합 hook 본체 (pre · stop · compact).

mode (argv[1]):
  pre      PreToolUse — 매 툴 호출마다 "⏳ 작업 중…" 한 메시지에 한 줄씩 append
  stop     Stop       — 턴 종료 시 그 진행 메시지 삭제 (최종 응답만 남김)
  compact  PreCompact — 컨텍스트 압축 시작 시 "🗜️ 압축 중…" 무음 알림

봇 스코프(steve-only 등)는 호출하는 telegram-progress.sh 래퍼가 책임진다.
어떤 에러가 나도 항상 exit 0 (툴 실행/압축을 절대 막지 않음).

ENV 노브:
  TG_PROGRESS_THROTTLE  edit 최소 간격(초). default 1.2
  TG_PROGRESS_SYNC=1    edit 를 동기로 (default: detached curl, fire-and-forget)
"""
import sys, os, json, re, time, subprocess

SKIP_TOOLS = {"TodoWrite", "TodoRead"}


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "pre"
    state_dir = os.environ.get("TELEGRAM_STATE_DIR")
    if not state_dir:
        return
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except Exception:
        data = {}
    if mode == "stop":
        handle_stop(state_dir, data)
    elif mode == "compact":
        handle_compact(state_dir, data)
    elif mode == "react":
        handle_react(state_dir, data)
    else:
        handle_pre(state_dir, data)


# ── UserPromptSubmit ────────────────────────────────────────
def _react_self_id():
    env = os.environ.get("OWNER_GATE_SELF")
    if env:
        return env
    base = os.path.basename(os.environ.get("TELEGRAM_STATE_DIR", "").rstrip("/"))
    return base[len("telegram-"):] if base.startswith("telegram-") else "bill"


def _team_group_env():
    # team-collab/.env 의 TEAM_GROUP_ID 폴백 (소스에 실 chat_id 비노출). 없으면 "".
    try:
        envp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
        with open(envp) as f:
            for line in f:
                if line.startswith("TEAM_GROUP_ID="):
                    return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return ""


def _react_owner_skip(chat_id, text, msg_id=""):
    """thin-client: 그룹 메시지 owner suppress 판단을 서버(/api/route)에 위임.
    self + 원본 telegram message_id 를 보내고 서버 suppress=True면 👀 생략(tgMessageId로 reply/sticky 반영).
    owner/suppress 룰은 서버 한 곳(teamRouter.shouldSuppress). DM·비그룹·에러는 False(=👀 유지, fail-open). [OWNER 2098]"""
    group = os.environ.get("OWNER_GATE_GROUP") or _team_group_env()
    if not group or chat_id != group:
        return False
    text = (text or "").strip()
    if not text:
        return False
    try:
        import urllib.request
        body = json.dumps({"text": text, "self": _react_self_id(), "tgMessageId": msg_id}).encode()
        req = urllib.request.Request(
            os.environ.get("OWNER_GATE_ROUTE_URL", "http://127.0.0.1:7878/team/api/route"),
            data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=2) as r:
            d = json.loads(r.read().decode())
    except Exception:
        return False  # fail-open → 👀 유지
    return bool(d.get("suppress"))


def _pick_emoji(text):
    """메시지 내용 기반 ack 이모지(훅 레벨 키워드, 기본 👀). 텔레그램 화이트리스트만."""
    t = (text or "").lower()
    if re.search(r"칭찬|좋아|굿|훌륭|멋지|최고|lgtm|good job|잘했|수고", t): return "👍"
    if re.search(r"축하|완성|배포 완료|release|드디어|done!|끝났", t): return "🎉"
    if re.search(r"긴급|중요|critical|asap|당장|지금 바로|!!!", t): return "🔥"
    if re.search(r"고마|감사|thank", t): return "🙏"
    if re.search(r"\?|왜|어떻게|뭐야|되나|될까|맞나|확인해|봐줄래", t): return "🤔"
    return "👀"


def handle_react(state_dir, data):
    """들어온 텔레그램 메시지에 즉시 내용기반 ack 이모지 — 툴이 없는 텍스트 답변에도 '받았어요' 신호.
    UserPromptSubmit 는 prompt 안에 <channel> 태그가 들어옴(transcript 아님).
    owner-only 👀(2026-06-02): 비-owner 그룹 메시지는 게이트와 동일 판정으로 👀 생략."""
    prompt = data.get("prompt", "") or ""
    # <channel>(봇 직접 수신) — (attrs, body) 쌍. owner-check 에 body 필요. 닫는 태그 없으면 미매칭(그땐 👀 생략).
    tags = [(a, txt) for a, txt in re.findall(r"<channel\b([^>]*)>(.*?)</channel>", prompt, re.DOTALL) if "telegram" in a]
    # <external_message>(capture 주입, 그룹 @별칭 등) — 주입 = 그 봇이 owner 확정이라 무조건 👀(owner-check 불필요).
    ext = [(a, b) for a, b in re.findall(r"<external_message\b([^>]*)>(.*?)</external_message>", prompt, re.DOTALL) if "telegram" in a]
    _dbg(state_dir, f"react entry plen={len(prompt)} tags={len(tags)} ext={len(ext)}")
    if not tags and not ext:
        return
    token = read_token(state_dir)
    if not token:
        return
    # 배치/인터럽트로 여러 메시지가 한 prompt 에 묶이면 전부 react (마지막만 X). fix 2026-05-25.
    # 극단 batch 오버헤드 방어로 마지막 6개만.
    seen = set()
    last_key = None
    for attrs, body in tags[-6:]:
        cid = re.search(r'chat_id="([^"]+)"', attrs)
        mid = re.search(r'message_id="([^"]+)"', attrs)
        if not (cid and mid):
            continue
        key = (cid.group(1), mid.group(1))
        last_key = key
        if key in seen:
            continue
        seen.add(key)
        if _react_owner_skip(cid.group(1), body, mid.group(1)):
            _dbg(state_dir, f"react skip (non-owner) chat={key[0]} msg={key[1]}")
            continue
        _dbg(state_dir, f"react send chat={key[0]} msg={key[1]}")
        tg_react(token, key[0], key[1], _pick_emoji(body))
    # capture 주입 메시지: 원본 telegram message_id(tg_msg_id) + thread(tg-CHATID)로 ack. owner 확정이라 무조건.
    for attrs, body in ext[-6:]:
        tgmsg = re.search(r'tg_msg_id="([^"]+)"', attrs)
        thread = re.search(r'thread="([^"]+)"', attrs)
        if not (tgmsg and thread):
            continue
        chat = thread.group(1)
        if chat.startswith("tg-"):
            chat = chat[3:]
        key = (chat, tgmsg.group(1))
        if key in seen:
            continue
        seen.add(key)
        _dbg(state_dir, f"react send (injected) chat={key[0]} msg={key[1]}")
        tg_react(token, key[0], key[1], _pick_emoji(body))
    # 이 turn 의 채널 기억 → handle_pre 가 progress 를 '작업한 방'에만 띄움 (방별 분리, 2026-05-27 OWNER).
    if last_key:
        _save_turn_channel(state_dir, data.get("session_id", "default"), last_key[0], last_key[1])


# ── PreToolUse ──────────────────────────────────────────────
def handle_pre(state_dir, data):
    tool = data.get("tool_name", "")
    # 최종 답변(텔레그램 reply) 직전 = 진행 메시지를 먼저 지우고 답이 나가게.
    # (owner 요청 순서: "작업 중" 삭제 → 답변. Stop 불발과 무관하게 신뢰성 확보.)
    if tool == "mcp__plugin_telegram_telegram__reply":
        clear_progress(state_dir, data, "reply")
        return
    if tool.startswith("mcp__plugin_telegram_telegram") or tool in SKIP_TOOLS:
        return
    line = format_line(tool, data.get("tool_input") or {}, data)
    if not line:
        return
    # 이 turn 의 채널을 우선 사용(handle_react 가 UserPromptSubmit 때 기억) → progress 를
    # '작업한 방'에 분리해 띄움. 없으면(주입/태그없음) 기존 폴백 + 주입 skip. (2026-05-27 OWNER: 방별 분리)
    sid = data.get("session_id", "default")
    chat_id, turn_id = _read_turn_channel(state_dir, sid)
    if not chat_id:
        # 그룹 @멘션 capture 주입(<external_message>)은 <channel> 태그가 없어 turn-channel 미저장
        # → parse_transcript 가 stale DM 일 수 있으니, 주입 작업이면 진행표시 skip. (2026-05-25)
        if _latest_inbound_injected(data.get("transcript_path", "")):
            return
        chat_id, turn_id = parse_transcript(data.get("transcript_path", ""))
    if not chat_id:
        return
    token = read_token(state_dir)
    if not token:
        return

    session_id = data.get("session_id", "default")
    pdir = os.path.join(state_dir, "progress")
    os.makedirs(pdir, exist_ok=True)
    sfile = os.path.join(pdir, session_id + ".json")

    st = load_state(sfile)
    if st.get("chat_id") != chat_id or st.get("turn_id") != turn_id:
        # 턴 교체인데 이전 진행 메시지가 남아 있으면(인터럽트로 Stop 미발사 등)
        # 그대로 두면 고아 메시지 → 새 턴 리셋 전에 먼저 삭제.
        old_mid, old_chat = st.get("message_id"), st.get("chat_id")
        if old_mid and old_chat:
            tg_delete(token, old_chat, old_mid)
        st = {"chat_id": chat_id, "turn_id": turn_id,
              "message_id": None, "lines": [], "last_ts": 0.0}

    st["lines"].append(line)
    st["lines"] = st["lines"][-40:]
    text = render(st["lines"])
    now = time.time()

    if not st.get("message_id"):
        mid = tg_send(token, chat_id, text)
        _dbg(state_dir, f"pre first-send mid={mid} tool={data.get('tool_name')}")
        if mid:
            st["message_id"] = mid
            st["last_ts"] = now
    else:
        throttle = float(os.environ.get("TG_PROGRESS_THROTTLE", "1.2"))
        if now - st.get("last_ts", 0.0) >= throttle:
            tg_edit(token, chat_id, st["message_id"], text)
            st["last_ts"] = now

    save_state(sfile, st)


# ── Stop ────────────────────────────────────────────────────
def handle_stop(state_dir, data):
    clear_progress(state_dir, data, "stop")


def clear_progress(state_dir, data, src=""):
    """진행 메시지 삭제 + 상태 제거. reply 직전(pre) / 턴 종료(stop) 양쪽에서 호출."""
    session_id = data.get("session_id", "default")
    sfile = os.path.join(state_dir, "progress", session_id + ".json")
    st = load_state(sfile)
    mid, chat = st.get("message_id"), st.get("chat_id")
    if mid and chat:
        token = read_token(state_dir)
        if token:
            tg_delete(token, chat, mid)
    try:
        os.remove(sfile)
    except Exception:
        pass
    _clear_turn_channel(state_dir, session_id)
    _dbg(state_dir, f"clear src={src} sid={session_id[:8]} mid={mid}")


def _dbg(state_dir, msg):
    try:
        with open(os.path.join(state_dir, "progress", "_hooklog.txt"), "a") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
    except Exception:
        pass


# ── PreCompact ──────────────────────────────────────────────
def handle_compact(state_dir, data):
    chat_id = parse_chat(data.get("transcript_path", ""))
    if not chat_id:
        return
    token = read_token(state_dir)
    if not token:
        return
    trigger = data.get("trigger", "")
    kind = "수동 /compact" if trigger == "manual" else "자동"
    text = (f"🗜️ 컨텍스트 {kind} 압축 중… 대화가 길어져 정리하는 중이에요. "
            f"조금 걸릴 수 있어요 — 멈춘 게 아닙니다.")
    pdir = os.path.join(state_dir, "progress")
    os.makedirs(pdir, exist_ok=True)
    session_id = data.get("session_id", "default")
    cfile = os.path.join(pdir, session_id + ".compact")

    old = None  # 직전 압축 알림 제거(중복 방지)
    try:
        with open(cfile) as f:
            old = json.load(f).get("message_id")
    except Exception:
        pass
    if old:
        tg_delete(token, chat_id, old)

    mid = tg_send(token, chat_id, text)
    if mid:
        try:
            with open(cfile, "w") as f:
                json.dump({"chat_id": chat_id, "message_id": mid}, f)
        except Exception:
            pass


# ── 공통 헬퍼 ────────────────────────────────────────────────
def b(p):
    return os.path.basename(str(p).rstrip("/")) if p else ""


def trunc(s, n):
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s if len(s) <= n else s[:n - 1] + "…"


def format_line(tool, tin, data):
    if tool == "Bash":
        cmd = (tin.get("command") or "").strip().splitlines()
        cmd = trunc(cmd[0] if cmd else "", 68)
        cwd = b(data.get("cwd", ""))
        return f"🛠️ $ {cmd}" + (f"  ({cwd})" if cwd else "")
    if tool == "Read":
        return f"📖 read {b(tin.get('file_path', ''))}"
    if tool in ("Edit", "MultiEdit"):
        return f"✏️ edit {b(tin.get('file_path', ''))}"
    if tool == "Write":
        return f"📝 write {b(tin.get('file_path', ''))}"
    if tool == "NotebookEdit":
        return f"✏️ notebook {b(tin.get('notebook_path', ''))}"
    if tool == "Glob":
        return f"🔎 glob {trunc(tin.get('pattern', ''), 50)}"
    if tool == "Grep":
        return f"🔎 grep {trunc(tin.get('pattern', ''), 50)}"
    if tool in ("Task", "Agent"):
        d = tin.get("description") or tin.get("subagent_type") or "agent"
        return f"🤖 {trunc(d, 55)}"
    if tool == "WebFetch":
        u = tin.get("url", "")
        m = re.search(r"https?://([^/]+)", u)
        return f"🌐 fetch {m.group(1) if m else trunc(u, 40)}"
    if tool == "WebSearch":
        return f"🌐 search {trunc(tin.get('query', ''), 45)}"
    if tool.startswith("mcp__"):
        return f"🔌 {tool.split('__')[-1]}"
    return f"🛠️ {tool}"


def render(lines):
    show = lines[-12:]
    extra = len(lines) - len(show)
    body = "\n".join(show)
    if extra > 0:
        body = f"… (+{extra})\n" + body
    return "⏳ 작업 중…\n" + body


def read_token(state_dir):
    try:
        with open(os.path.join(state_dir, ".env")) as f:
            for ln in f:
                ln = ln.strip()
                if ln.startswith("TELEGRAM_BOT_TOKEN="):
                    return ln.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return None


def tail_blob(path, n=300000):
    if not path or not os.path.exists(path):
        return ""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if size > n:
                f.seek(size - n)
            return f.read().decode("utf-8", "ignore")
    except Exception:
        return ""


def parse_transcript(path):
    """transcript tail 에서 마지막 inbound telegram 태그의 (chat_id, message_id).
    message_id 는 turn 식별자."""
    blob = tail_blob(path)
    m = re.findall(
        r'source=\\?"plugin:telegram[^\n]*?chat_id=\\?"?(-?\d+)\\?"[^\n]*?message_id=\\?"?(\d+)',
        blob)
    if m:
        return m[-1][0], m[-1][1]
    return None, None


def _latest_inbound_injected(path):
    """transcript 의 가장 최근 inbound 가 capture <external_message> 주입(그룹 라우팅)이면 True.
    plugin <channel>(DM/멘션) 이면 False. 주입 작업의 진행표시 skip 판단용."""
    blob = tail_blob(path)
    ch = -1
    for m in re.finditer(r'source=\\?"plugin:telegram', blob):
        ch = m.start()
    ext = blob.rfind("external_message")
    return ext != -1 and ext > ch


def parse_chat(path):
    blob = tail_blob(path)
    m = re.findall(r'source=\\?"plugin:telegram[^\n]*?chat_id=\\?"?(-?\d+)', blob)
    return m[-1] if m else None


def _turnch_path(state_dir, sid):
    return os.path.join(state_dir, "turnch", sid + ".json")


def _save_turn_channel(state_dir, sid, chat_id, message_id):
    """현재 turn 을 시작시킨 메시지의 (chat_id, message_id) 기억 → progress 를 그 방에만 띄움."""
    try:
        os.makedirs(os.path.join(state_dir, "turnch"), exist_ok=True)
        with open(_turnch_path(state_dir, sid), "w") as f:
            json.dump({"chat_id": chat_id, "message_id": message_id, "ts": time.time()}, f)
    except Exception:
        pass


def _read_turn_channel(state_dir, sid):
    try:
        with open(_turnch_path(state_dir, sid)) as f:
            d = json.load(f)
        return d.get("chat_id"), d.get("message_id")
    except Exception:
        return None, None


def _clear_turn_channel(state_dir, sid):
    try:
        os.remove(_turnch_path(state_dir, sid))
    except Exception:
        pass


def load_state(p):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(p, st):
    try:
        with open(p, "w") as f:
            json.dump(st, f)
    except Exception:
        pass


def tg_send(token, chat_id, text):
    import urllib.request, urllib.parse
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = urllib.parse.urlencode({
        "chat_id": chat_id, "text": text, "disable_notification": "true",
    }).encode()
    try:
        with urllib.request.urlopen(url, data=payload, timeout=3) as r:
            return json.load(r).get("result", {}).get("message_id")
    except Exception:
        return None


def tg_delete(token, chat_id, mid):
    import urllib.request, urllib.parse
    url = f"https://api.telegram.org/bot{token}/deleteMessage"
    payload = urllib.parse.urlencode({"chat_id": chat_id, "message_id": mid}).encode()
    try:
        urllib.request.urlopen(url, data=payload, timeout=3).read()
    except Exception:
        pass


def tg_react(token, chat_id, mid, emoji):
    import urllib.request
    url = f"https://api.telegram.org/bot{token}/setMessageReaction"
    body = json.dumps({"chat_id": str(chat_id), "message_id": int(mid),
                       "reaction": [{"type": "emoji", "emoji": emoji}]}).encode()
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=5).read()
    except Exception:
        pass


def tg_edit(token, chat_id, mid, text):
    url = f"https://api.telegram.org/bot{token}/editMessageText"
    if os.environ.get("TG_PROGRESS_SYNC") == "1":
        import urllib.request, urllib.parse
        payload = urllib.parse.urlencode({
            "chat_id": chat_id, "message_id": mid, "text": text,
        }).encode()
        try:
            urllib.request.urlopen(url, data=payload, timeout=3).read()
        except Exception:
            pass
        return
    # 기본: detached curl — 훅 즉시 리턴, 툴 지연 0
    try:
        subprocess.Popen(
            ["curl", "-s", "--max-time", "5", url,
             "--data-urlencode", f"chat_id={chat_id}",
             "--data-urlencode", f"message_id={mid}",
             "--data-urlencode", f"text={text}"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True)
    except Exception:
        pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
