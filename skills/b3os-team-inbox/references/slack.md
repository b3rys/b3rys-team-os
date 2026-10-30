# 슬랙에 글 올리기 (`slack-post.sh`)

슬랙 게시 경로는 이것 하나다. 코드를 뒤져 다른 경로를 만들지 않는다.

```bash
/절대경로/skills/b3os-team-inbox/scripts/slack-post.sh --channel <C...> --text "..."
/절대경로/skills/b3os-team-inbox/scripts/slack-post.sh --channel <C...> --text "..." --thread <ts>   # 스레드 답글
```

- 신원은 워크스페이스에서 자동 판정된다(`_me.sh`). `--as` 는 관리자용이다.
- 봇 토큰 파일을 직접 열지 않는다. 이 스크립트가 서버를 거쳐 처리한다.
- 라이브 트리의 스크립트를 절대경로로 부른다. 워크트리(작업 사본)에서 부르면 그 사본의 `team.db` 를 보게 돼 "agent id 해석 실패" 가 난다.

## 멘션이 없으면 도달하지 않는다

서버는 슬랙에서 `app_mention` 이벤트만 받는다(`routes/slack.ts`).

- 멘션 없는 글은 팀원에게 전달되지 않고 오류도 안 난다. 상대가 조용하면 "무시"가 아니라 "안 들어간 것"일 수 있다.
- 내가 멘션 없이 답하면 상대는 내가 침묵했다고 본다.
- 부를 때는 `<@U...>` 형식이다. 한글 이름은 멘션이 아니다. ID 조회:

```bash
curl -s http://127.0.0.1:7878/team/api/slack/status \
  | python3 -c "import sys,json;[print(m['id'], m.get('slack_bot_user_id')) for m in json.load(sys.stdin)['members']]"
```

## 확인은 받되 되받지 않는다

- "답장 불필요"로 끊지 않는다(읽었는지 알 수 없게 된다). 한 줄 확인만 받고, 그 확인에 다시 답하지 않아 체인을 끊는다.
- 슬랙 경로에는 버스의 체인 한도가 걸리지 않는다(인바운드가 `source="user"`·`hop_count=0` 이라 봇↔봇 검사 `source==="agent"` 를 통과한다). 사람 쪽 규율로 막는다.

길거나 단계가 있는 글은 `b3os-slack-format` 스킬을 쓴다. 첫 글은 짧게, 상세는 물어보면 그때.
