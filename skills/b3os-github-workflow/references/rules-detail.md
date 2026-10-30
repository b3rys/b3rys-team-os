# 상세 — 승인 기록의 한계, 설정 쓰기, 공개 저장소 규칙

SKILL.md 에서 필요할 때만 연다.

## 설정 쓰기 (비어 있어 채울 때)

물어볼 것은 둘이다: PR 을 올릴 계정, 승인할 계정. 둘은 서로 달라야 리뷰 요건이 성립한다.

```bash
curl -X PUT -H 'Content-Type: application/json' \
  -d '{"github_team_account":"<팀 작업 계정>","github_approver_account":"<승인 계정>","merge_approvers_normal":"<승인 가능한 팀원>"}' \
  http://127.0.0.1:7878/team/api/settings
curl -fsS http://127.0.0.1:7878/team/api/settings | python3 -m json.tool | grep github
```

- 세 값은 한 번에 검증되고 저장된다. 하나가 틀리면 아무것도 바뀌지 않는다. 이름에 한글·`@` 를 쓰면 400 이다.
- API 응답에 키가 없으면 이 변경이 배포되기 전이다. 그때만 DB 에서 직접 읽을 수 있고, 배포 후에는 API 만 쓴다.

## 커밋 신원 보충

- `git config` 값은 worktree 가 공유하는 `.git/config` 하나라 다른 팀원이 덮을 수 있다. 설정했으면 커밋 직전에 `git config user.name` / `user.email` 을 다시 본다. 이름이 갈리는 값이다(이메일은 팀 계정 하나로 공통).
- `--global` 은 건드리지 않는다.

## 승인 기록(`Approved-by`)의 한계

- 이 줄은 누가 봤는지를 기록할 뿐 신원을 증명하지 않는다. 승인 계정이 공유라 다른 사람의 이름도 적을 수 있다. 위조 방지는 팀원별 GitHub 계정이 필요하고 별도 결정이다.
- 같은 계정의 최종 리뷰 하나만 유효해서 기록에는 한 명만 남는다. 원리적으로 2명까지만 표현되므로 "3명이 봤다" 의 근거로 쓰지 않는다.
- PR 리뷰 도장의 `Approved-by:` 와 권한 승인(`src/server/lib/approvals.ts`)의 같은 이름 트레일러는 다른 제도다.
- 산문 대신 정해진 한 줄을 쓰는 이유: 산문에서 이름을 파싱하면 인용문·부정문·할일·조사·역할어·기술 용어(`direct-to-<역할>`)·이스케이프 개행에서 오판이 난다.
- `release-preflight.sh --mode merge` 는 사람이 돌려야 걸리는 자발적 게이트다(CI 필수 검사 아님). `approver-check.py` 를 따로 부르지 않고 preflight 를 진입점으로 쓴다.

## 공개 저장소

- `main` force-push 금지: 남의 clone 이 깨지고 fork·`refs/pull/*`·미러에는 이미 남는다. 잘못 올라간 것은 `git revert <문제커밋>`.
- 시크릿 유출 시: ① 키 폐기·재발급(복제됐다고 가정) → ② GitHub 에 캐시 제거 요청 → ③ 재작성 + `--force-with-lease` → ④ "히스토리가 바뀌었으니 다시 clone" 공지. force-push 직전에 원격 tip 이 준비 시점과 같은지 확인한다(그 사이 머지를 덮어쓰지 않도록).
- 태그는 옮기지 않고 새 버전을 낸다. 작업 브랜치는 rebase 후 `--force-with-lease` 가 일상이다.
- 외부 기여: fork PR 은 시크릿에 접근하지 못한다고 보고 워크플로를 짠다. `.github/workflows/` 수정은 실행 권한 변경이라 코드와 같이 리뷰한다. 계정 분리·승인자 표기는 우리 규율이라 외부 기여자에게 요구하지 않는다.

## 한계

계정을 나눠도 실질 분리는 아니다. 같은 기기·같은 팀원이 두 계정을 쓴다. 이 절차가 주는 것은 누가 무엇을 했는지의 정확한 기록이고, 우회 방지는 규율에 의존한다.
