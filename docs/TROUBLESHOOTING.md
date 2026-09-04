# 맥 부팅 후 안 뜰 때 (Trouble Shooting)

**보통은 맥을 켜면 저절로 올라옵니다.** 아래는 그게 안 됐을 때만 씁니다.

```bash
bash bin/team-os up       # 올린다
bash bin/team-os doctor   # 왜 안 뜨는지 본다
bash bin/team-os down     # 내린다
```

**순서는 이렇게** — `up` 먼저, 그래도 안 되면 `doctor`.

### `up` — 올린다

**맥을 켰을 때 떠 있어야 할 것을 전부** 올리고, 20초 뒤 결과를 보여줍니다.
서버·팀원·연동 다리가 모두 대상입니다. **팀원 이름은 설치마다 다르므로 이름을 고정하지 않고**
자동실행 설정을 직접 읽어 찾습니다.

```
■ 올립니다
  · com.you.team-collab (정상)
  → com.you.claude-telegram-bill 등록
  · 서버 응답 정상
■ 결과
  ✓ 서버 정상 (팀원 12명)
  ✓ 자동실행 7개 전부 정상

  됐습니다. 텔레그램으로 팀원에게 말 거세요.
```

이렇게 나오면 끝입니다. 그 뒤엔 **텔레그램으로 팀원에게 말을 걸면 됩니다.**

- 이미 떠 있는 것은 **건드리지 않습니다** — 둘로 뜨거나, 막 올라오던 걸 죽이지 않게.
- **"등록됨" 이 아니라 "지금 살아있음" 으로 판단합니다.** 등록만 되고 죽어 있으면 다시 올립니다.
- 자동실행 등록 자체가 없으면 **등록부터 하고** 올립니다.
- **정해진 시각에 도는 예약 작업은 대상이 아닙니다** — 다시 등록하면 같은 일이 두 번 돕니다.
- 하나라도 못 살리면 **성공이라고 말하지 않습니다** (종료 코드도 실패).
- 두 번 눌러도 안전합니다.

### `doctor` — 왜 안 뜨는지 본다

`up` 으로 안 되면 이걸 돌리고, **나온 내용을 그대로 팀원에게 주세요.**

```
■ 점검
  ✓ 서버 정상 (팀원 12명)
  ✗ 자동실행 7개 중 6개만 정상

■ 하나씩
  ✓ com.you.team-collab — 정상
  ✗ com.you.claude-telegram-bill — 등록은 됐는데 안 돌고 있음 → team-os up
  …

■ 마지막 오류 3줄
  …
```

### `down` — 내린다

**`up` 이 올리는 것을 전부 내립니다.** 서버·팀원·연동 다리 모두입니다.
팀원은 자동실행만 내리면 세션이 계속 살아 있으므로 **세션까지 같이 닫습니다.**

**맥을 끄기 전에 팀을 통째로 세울 때 씁니다.** 다시 올릴 땐 `team-os up`.

### 그래도 안 되면

서버를 **손으로 띄워서 화면의 오류를 그대로** 보세요.

```bash
bun run src/server/index.ts
```

오류가 보이면 **Ctrl+C** 로 끄고, 그 내용을 팀원에게 주면 됩니다.

### 오픈클로 게이트웨이가 안 뜰 때 — ★오류는 `/tmp/openclaw/openclaw-<날짜>.log` 에 있다★

증상: OpenClaw 런타임으로 도는 팀원이 한꺼번에 답이 없다. 어느 팀원이 그 런타임인지는 `agents.json` 의 `runtime` 이 `openclaw` 인 항목이다.

먼저 이것부터 봅니다.

```bash
launchctl list | grep ai.openclaw.gateway
```

앞자리가 `-` 이고 뒤가 `1` 이면 켜자마자 종료된 것입니다. launchd 가 10초마다 다시 켜고 그때마다 같은 이유로 죽습니다.

**오류가 어디에 남는지 먼저 알아야 합니다.** 이 서비스는 `StandardErrorPath` 가 `/dev/null` 이라 오류를 버립니다(`~/Library/LaunchAgents` 의 `ai.openclaw`·`ai.hermes`·`com.gdmini` 라벨 23개 중 이것 하나. 2026-09-05 실측).
`~/Library/Logs/openclaw/gateway.log` 에는 Doctor 경고만 반복해서 찍힙니다. 그것만 보면 원인을 못 찾습니다.

★실제 오류는 `/tmp/openclaw/openclaw-<날짜>.log` 에 있습니다.★ 경로는 아래 명령이 알려줍니다.

```bash
openclaw gateway status --deep     # File logs: 줄에 그 경로가 나옵니다
tail -50 /tmp/openclaw/openclaw-$(date +%F).log
```

`/tmp` 아래라 맥을 껐다 켜면 지워집니다. 재부팅 전에 봐야 합니다.

실제 사례(2026-09-03). 로그에 이렇게 찍혀 있었습니다.

```
OpenClaw startup migrations did not complete cleanly; refusing to report the gateway ready.
```

옮기지 못한 항목이 있으면 게이트웨이가 "준비됐다" 고 보고하지 않습니다. 그날은 셋이었습니다.

- `~/.openclaw/credentials/telegram-<계정>-allowFrom.json` 두 개 — 그 계정이 지금 설정에 없어서 옮길 곳을 못 찾음
- `telegram.message-cache` 가 3000개로 꽉 참 — 옮길 항목 1개인데 자리가 없음

처리한 방법입니다. **지우기 전에 백업합니다.**

★무엇을 고치든 먼저 게이트웨이를 멈춥니다.★ `KeepAlive` 가 `true` 이고 `ThrottleInterval` 이 10 이라,
멈추지 않으면 launchd 가 10초마다 다시 켜는 도중에 파일을 고치게 됩니다.
`credentials` 아래 파일도 startup migration 이 읽으므로 그 이동도 멈춘 뒤에 합니다.

```bash
set -e
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p ~/.openclaw/backups/$STAMP

openclaw gateway stop

# 없어진 계정 파일 — 백업 폴더로 이동
mv ~/.openclaw/credentials/telegram-<계정>-allowFrom.json ~/.openclaw/backups/$STAMP/

# 백업 → 무결성 확인 → 오래된 것부터 삭제
sqlite3 ~/.openclaw/state/openclaw.sqlite ".backup '$HOME/.openclaw/backups/$STAMP/openclaw.sqlite'"
[ "$(sqlite3 ~/.openclaw/backups/$STAMP/openclaw.sqlite 'pragma integrity_check;')" = "ok" ] || { echo "백업이 온전하지 않다 — 여기서 멈춘다"; exit 1; }
sqlite3 ~/.openclaw/state/openclaw.sqlite "DELETE FROM plugin_state_entries WHERE rowid IN (SELECT rowid FROM plugin_state_entries WHERE plugin_id='telegram' AND namespace='telegram.message-cache' ORDER BY created_at ASC LIMIT 100);"

openclaw gateway start
```

`integrity_check` 결과를 `ok` 와 대조합니다. 출력만 보고 넘어가면 백업이 깨져 있어도 다음 줄이 지웁니다.

`$STAMP` 를 쓰는 이유 — 백업 이름을 고정하면 두 번째 실행이 첫 번째 백업을 덮습니다.
`plugin_id='telegram'` 을 넣는 이유 — 이 표의 기본키가 `(plugin_id, namespace, entry_key)` 라
같은 namespace 를 다른 plugin 이 쓸 수 있습니다.

올라왔는지는 이것으로 봅니다.

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:18789/    # 200 이면 정상
```

### Codex 도구 호출 로그

OpenClaw Codex 세션의 도구 호출은 `~/.openclaw/agents/<계정>/agent/codex-home/sessions/YYYY/MM/DD/rollout-*.jsonl` 에 기록됩니다.
`custom_tool_call`의 도구 이름과 입력을 함께 확인해 실제 파일 읽기 명령의 대상과 대화·검색에 포함된 단순 경로 언급을 구분합니다.

### Claude 도구 호출 로그

Claude 세션의 도구 호출은 `~/.claude/projects/<작업 디렉터리 경로를 -로 바꾼 이름>/<세션 UUID>.jsonl` 에 기록됩니다. 한 줄이 JSON 하나이고, 도구 호출은 `message.content[]` 안의 `type: "tool_use"` 항목에 `name`(도구)과 `input`(인자)으로 남습니다.

**이름이 인자에 들어 있는 것은 읽었다는 뜻이 아닙니다.** 그 파일을 화제로 삼아 메시지를 보내거나 이름으로 검색하기만 해도 같은 문자열이 `Bash` 인자에 그대로 찍힙니다. 이쪽이 실제 읽기보다 두 자릿수 배 많아서, 이름 매칭만으로 세면 **모두가 모든 파일을 읽은 것으로 나옵니다.** 읽었는지는 아래 둘로만 셉니다.

- `name` 이 `Read` 이고 `input.file_path` 가 그 파일을 가리킨다
- `name` 이 `Skill` 이고 `input.skill` 이 그 스킬이다

`Bash` 인자에 이름만 있는 것은 언급으로 봅니다. 그 명령이 읽기였는지 가리려면 명령 문자열을 해석해야 하는데, 한 명령 안에 메시지 본문이 함께 들어 있는 경우가 많아 자동 판정에는 쓰지 않습니다.

> 💡 **직접 외우거나 적어둘 것이 없습니다.** `team-os` 가 알아서 찾습니다.
>
> - **자동실행 이름**(`com.<사용자>.…`)은 설치마다 다릅니다 →
>   `~/Library/LaunchAgents/*.plist` 를 열어 안에 적힌 `Label` 을 그대로 읽습니다.
> - **저장소 위치**도 설치마다 다릅니다 →
>   이 스크립트가 `<저장소>/bin/team-os` 자리에 있으므로 **자기 위치에서 알아냅니다.**
>   바로가기(심링크)로 불러도 끝까지 따라갑니다.
>
> 스크립트를 저장소 밖으로 복사해서 쓰신다면 그때만 알려주세요:
> `TEAM_OS_REPO=<저장소 경로> team-os doctor`

### 며칠 꺼뒀다가 켜면 — 밀린 예약 작업은 어떻게 되나

예약 작업은 디스크에 저장되므로 **꺼도 없어지지 않습니다.**

**밀린 것이 쌓이지는 않습니다.** 다음 실행 시각을 *지금* 기준으로 다시 잡고 지나간 차례를
채워 돌리지 않기 때문에, 30분마다 도는 작업을 사흘 꺼둬도 **144번이 아니라 한 번** 돕니다.

그래서 며칠 만에 켜시면 **작업마다 한 번씩, 켠 직후에 몰려서** 옵니다.

#### 그게 시끄러우면 — 지난 것은 건너뛰게 할 수 있습니다 (기본은 꺼짐)

```bash
SCHEDULER_MISFIRE_GRACE_SEC=7200   # 2시간 넘게 지난 차례는 실행하지 않음
```

**기본은 꺼져 있습니다.** 켜면 조용해지지만 **놓친 것이 조용히 없어집니다** —
한 번짜리 알림은 다음 차례가 없고, 주간 작업은 한 주가 통째로 빕니다.
시끄러운 쪽이 없어지는 쪽보다 낫다고 보아 **원할 때만 켜는 값**으로 두었습니다.

건너뛴 기록은 실행 이력에 `skipped` 로 남습니다.

- 켠 상태에서도 **늦더라도 반드시 실행해야 하는 작업**은 `misfire_policy` 를
  `catch_up_once` 로 둡니다. 예약 알림은 만들 때 `misfire_policy` 로 지정할 수 있습니다.
