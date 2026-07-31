# 설정에서 읽을 값

아래 값은 **이 문서에 적지 않는다.** 환경마다 다르고, 문서에 박히면 그 자체가 공격 지점 안내가 된다.

| 값 | 어디서 읽나 |
|---|---|
| 팀원 작업용 GitHub 계정 | 설정 `github_team_account` |
| 승인용 GitHub 계정 | 설정 `github_approver_account` |

이 단계를 건너뛰면 PR 이 승인 계정으로 만들어져 머지가 막힌다.

**읽는 법:**

```bash
S=$(curl -fsS http://127.0.0.1:7878/team/api/settings)
TEAM_ACCOUNT=$(printf '%s' "$S" | python3 -c 'import json,sys;print(json.load(sys.stdin)["github_team_account"])')
[ -n "$TEAM_ACCOUNT" ] || { echo "설정이 비어 있다 — 중단"; exit 1; }
```

**비어 있으면 팀장에게 물어서 채운다.** 값을 지어내지 않는다. 물어볼 것은 둘이다 —
**PR 을 올릴 계정**과 **승인할 계정**. 두 계정은 서로 달라야 리뷰 요건이 성립한다.

**쓰는 법:**

```bash
curl -X PUT -H 'Content-Type: application/json' \
  -d '{"github_team_account":"<팀 작업 계정>","github_approver_account":"<승인 계정>","merge_approvers_normal":"<승인 가능한 팀원>"}' \
  http://127.0.0.1:7878/team/api/settings
# 성공하면 반드시 다시 읽어 확인한다 — 쓰기 성공이 반영을 뜻하지 않는다
curl -fsS http://127.0.0.1:7878/team/api/settings | python3 -m json.tool | grep github
```

**세 값은 한 번에 검증되고 한 번에 저장된다** — 하나가 틀리면 **아무것도 안 바뀐다**
(반쯤 바뀐 보안 설정이 제일 위험하다). 이름에 한글·`@` 를 쓰면 **쓰는 시점에 400** 이다 —
판정기가 못 읽는 값을 넣어두면 **머지할 때 알 수 없는 이유로 막힌다.**

**API 응답에 그 키가 없으면 아직 이 변경이 배포되기 전이다.** 그때 한해 DB 에서 직접 읽어 진행할 수 있다
(그 기능을 처음 올리는 부트스트랩 상황).
**배포 후에는 API 만 쓴다** — DB 직접 읽기는 정상 경로가 아니다.
| 커밋 신원 이메일 | 설정 `github_team_commit_email` |
| tier별 승인자 | 설정 (`merge_approvers_*`) · 판정은 `approvals.ts` |
| 저장소·조직 | `git remote` 실측 |

**설정이 비어 있으면 진행하지 않는다.** 기본값으로 때우면 팀장 개인 계정으로 나가고, 그게 이 절차가 막으려는 바로 그 일이다.
