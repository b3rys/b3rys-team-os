---
name: b3os-github-workflow
description: 팀원이 코드 변경을 GitHub PR로 올려 승인·머지까지 가는 절차 — 브랜치·worktree 격리, 커밋 신원, PR 작성 계정, 검증 근거, 승인 기록(Approved-by), 머지 후 확인. 저장소에 남는 글(코드·주석·커밋·PR·이슈·문서)을 사실과 인과로 쓰는 규칙도 여기 있다. 승인·안전 정책은 TEAM-OS가 정본이고 여기는 절차만 다룬다.
trigger: branch·PR·merge · writing anything that lands in the repo
---
# GitHub 워크플로 — 변경을 PR로 올려 머지까지

b3os 인프라(소스·config·registry·릴리스)를 고치면 `b3os-infra-safety` 를 먼저 보고 이 절차를 얹는다. 각 단계에는 확인 명령이 있고, 기대와 다르게 나오면 그 자리에서 멈춘다.

## 저장소에 남는 글 — 사실과 인과만

저장소에 들어가는 것은 전부 공개물이다(코드·주석·커밋·PR·이슈·외부 문서). 회고·리뷰·교훈은 메모리와 `SHARED.md` 로 보낸다.

| 어디 | 무엇을 |
|---|---|
| README·가이드 | 하는 방법 + 확인 방법 |
| PR 본문 | 문제(사실) → 원인(인과) → 어떻게 고쳤나 → 검증 결과 |
| 커밋 메시지 | 무엇을 바꿨고 왜 맞는가 |
| 코드 주석 | 무엇을 하는가, 왜 이 조건이 필요한가 |

빼는 것:
- 회고성 서술: 사고 경위, "오늘 우리가", 작업 과정의 날짜, 관계없는 사람 이름, 시도했다 만 안, "처음엔 ~로 갔다가 되돌렸다".
- 팀 내부 대화 인용: 근거는 요구사항이나 측정값으로 쓴다. 외부 출처(업스트림 이슈·벤더 문서·표준)는 링크와 함께 남긴다.
- 자기비판: "내가 놓쳤다" 대신 무엇이 참인지를 쓴다.
- 사람에게 귀속된 리뷰 이력: "누구 리뷰에서 나왔다" 대신 무엇이 관측됐는지를 쓴다.

| 쓰지 않는다 | 대신 |
|---|---|
| `팀장님 지시 2026-07-30` | `요구사항:` |
| `GD 결정` · `팀 리드 결정` | `제품 결정:` |
| `팀장님 실측` · `<팀원> 지적` | `실측:` · `리뷰 지적:` |
| `codex 리뷰에서 나온` · `dbak 지적` | `리뷰에서 관측된` |
| `오늘 4건이 조용히 사라졌다` | `이 경로에서 4건이 통보 없이 유실된다` |

남기는 것: 관측값, 재현 조건, 인과, 검증 방법, 그 판단이 왜 맞는가. 무엇이 잘못 동작했는지와, 범위 축소처럼 결과에 영향을 준 판단의 근거("발생 0회로 실측되어 복구 로직 제외")는 사실이라 쓴다.

절차가 요구하는 신원은 그대로 쓴다: 커밋 author, `Co-authored-by` 등 git trailer, `Submitted-by`, 승인 계정, 버전·날짜. `Approved-by: <이름>` 은 머지 게이트가 `merge_approvers_normal` 과 대조하는 입력(`skills/b3os-release-ops/scripts/release-preflight.sh`)이라 "사람 이름 빼기" 로 지우면 게이트가 깨진다.

## 설정에서 읽을 값

값은 문서에 적지 않는다(환경마다 다르다).

| 값 | 어디서 |
|---|---|
| 팀원 작업용 GitHub 계정 | 설정 `github_team_account` |
| 승인용 GitHub 계정 | 설정 `github_approver_account` |
| 커밋 신원 이메일 | 설정 `github_team_commit_email` |
| tier별 승인자 | 설정 `merge_approvers_*` (판정은 `approvals.ts`) |
| 저장소·조직 | `git remote` 실측 |

```bash
S=$(curl -fsS http://127.0.0.1:7878/team/api/settings)
TEAM_ACCOUNT=$(printf '%s' "$S" | python3 -c 'import json,sys;print(json.load(sys.stdin)["github_team_account"])')
[ -n "$TEAM_ACCOUNT" ] || { echo "설정이 비어 있다 — 중단"; exit 1; }
```

비어 있으면 진행하지 않는다. 값을 지어내거나 기본값으로 때우면 팀장 개인 계정으로 나간다. 팀장에게 PR 계정과 승인 계정(서로 달라야 한다)을 물어 채운다. 쓰는 방법(PUT)과 읽기 검증은 `references/rules-detail.md`.

## 절차

### ① 격리

한 과제 = 한 브랜치, 공유 main 워킹트리에 직접 쓰지 않는다(상세 `b3os-infra-safety` ①②).

```bash
git worktree add <경로> -b <브랜치> origin/main
```

### ② 커밋 신원 — 팀원 이름 + 팀 계정

설정하지 않으면 전역 설정이 쓰여 팀장 개인 이름으로 나가고 경고는 없다. 커밋마다 명시한다(`-c` 는 그 명령에만 적용):

```bash
git -c user.name="<팀원 이름>" -c user.email="<설정 github_team_commit_email>" commit -m "..."
git log -1 --format='%an <%ae>'   # <내 이름> <팀 계정 주소> 여야 한다. 다르면 중단
```

`git config user.name/email` 방식을 쓰면 worktree 들이 `.git/config` 를 공유해 남이 덮을 수 있으니 커밋 직전에 이름까지 다시 확인한다. `--global` 은 건드리지 않는다(상세 `references/rules-detail.md`).

### ③ 구현과 검증

- baseline 실패 수와 mutation 실패 수를 분리해 기록하고, 돌린 테스트 범위를 같이 적는다.
- 수정이 고정됐는지는 원복해서 확인한다. 원복했을 때 테스트가 실패해야 한다.
- 새 테스트 파일이 무시 규칙에 걸려 빠지지 않았는지 `git show --stat HEAD` 로 본다.

### ④ push

push 계정은 승인 게이트에 영향이 없다. 게이트는 PR 작성자를 본다.

### ⑤ PR 작성 — 팀 계정으로

작성자가 승인자와 달라야 리뷰 요건이 성립한다. `GH_TOKEN="$(gh auth token ...)" gh ...` 한 줄은 조회가 실패하면 `gh` 가 빈 변수를 무시하고 기본 계정으로 에러 없이 나간다. 조회·검사·사용을 나눈다:

```bash
TOKEN="$(gh auth token --user "$TEAM_ACCOUNT")" || { echo "토큰 조회 실패 — 중단"; exit 1; }
[ -n "$TOKEN" ] || { echo "토큰이 비어 있다 — 중단"; exit 1; }
GH_TOKEN="$TOKEN" gh pr create --base main --fill

AUTHOR="$(gh pr view <번호> --json author --jq .author.login)"
[ "$AUTHOR" = "$TEAM_ACCOUNT" ] || echo "작성자가 $AUTHOR 다 — 잘못된 계정으로 생성됐다"
```

작성자가 다르면 그 PR 을 닫고 다시 만든다(작성자는 바꿀 수 없다). 토큰은 출력하거나 파일·로그에 남기지 않는다. `GH_TOKEN` 은 `gh` 에만 적용되고 일반 `git push` 에는 적용되지 않는다.

### ⑤-b PR 본문 — 핵심을 맨 앞에

읽는 사람이 결론까지 스크롤하지 않게 순서를 바꾼다(내용은 줄이지 않는다). 팀장 보고·리뷰 요청·커밋 제목도 같은 원칙이다.

```markdown
## 핵심 3줄
1. 무엇이 문제인가 (한 문장)
2. 언제 터지나 / 누가 영향받나 (발생 빈도·라이브 여부)
3. 어떻게 했나 + 규모(실제 코드 줄 수)

## 무엇을 바꿨나
| 문제 | 고친 방법 |
|---|---|

---
(이하 상세: 실측 근거 · 왜 이 크기인가 · 검증 · 뮤턴트)

Submitted-by: <팀원 ID>
```

PR 작성 계정이 공유라 GitHub 만으로는 누가 올렸는지 알 수 없다. `Submitted-by: <팀원 ID>` 는 본문 마지막 줄에 이 모양으로 둔다. 발견자·검증자 크레딧은 별개라 본문 안에 자유롭게 쓴다.

### ⑥ 검증 근거를 PR에 남긴다

본문이나 코멘트에:

```text
검증 범위:  <실행한 테스트 범위>
baseline:   <실패 수>
mutation:   <되돌린 것> → <실패 수>
미검증:     <확인하지 않은 범위>
```

미검증 칸은 비우지 않는다. 빈 칸은 "없다" 가 아니라 "안 적었다" 로 읽힌다.

### ⑦ 승인 요청

tier 판정과 승인자는 TEAM-OS 정책과 설정을 따른다.

- tier 를 스스로 낮게 표시하지 않는다. 애매하면 높은 쪽으로.
- 작성자는 자기 PR 을 승인하지 않는다. 기준은 계정이 아니라 사람이다.
- 리뷰 요청 후 push 했으면 한 줄 알린다. `dismiss_stale_reviews` 로 승인이 통지 없이 폐기된다.

승인은 PR 설명글이 아니라 리뷰 본문 마지막 줄에 `Approved-by: <승인자 ID>` 를 쓴다. 게이트는 `repos/<slug>/pulls/<번호>/reviews` 만 읽고 PR 본문은 보지 않는다. 이름은 `merge_approvers_normal` 에 있는 사람이어야 한다. 승인 토큰도 조회·검사·적용을 나눈다:

```bash
APPROVER=<설정 github_approver_account>
TOKEN="$(gh auth token --user "$APPROVER")" || { echo "토큰 조회 실패 — 중단"; exit 1; }
[ -n "$TOKEN" ] || { echo "토큰이 비어 있다 — 중단"; exit 1; }
GH_TOKEN="$TOKEN" \
  gh pr review <번호> --approve --body "$(printf '%s\n' '<사람이 읽을 말>' '' 'Approved-by: <승인자 ID>')"
```

- 작성 계정으로 승인하면 GitHub 이 self-approve 를 거부한다.
- `gh auth switch` 는 쓰지 않는다. 기계 전체의 활성 계정이 바뀐 채 남아 다음 사람의 PR 이 승인 계정 작성으로 잡히고, 그 PR 은 닫고 다시 만들어야 한다.
- `Approved-by:` 는 기록일 뿐 신원 증명이 아니고(승인 계정 공유), 같은 계정의 최종 리뷰 하나만 남아 "여러 명이 봤다" 의 근거로 쓸 수 없다. 이 한계를 문서에서 지우지 않는다(`references/rules-detail.md`).
- 머지 직전에 게이트에 물어본다. 사람이 돌려야 걸린다(CI 강제 아님). 진입점은 저장소에 따라 다르다: 정책 파일에 등록된 저장소는 `pr-gate.sh`(아래), 그 밖의 저장소는 아래 "등록되지 않은 저장소" 의 손 확인. b3os 출고 묶음은 출고 전에 `release-preflight.sh --mode merge` 도 함께 본다(`b3os-release-ops`).

#### 머지 준비 확인: `pr-gate.sh`

읽기 전용 확인 `pr-gate.sh` 로 머지 준비를 본다. 승인 판정은 `approver-check.py` 를 쓰되 작성 계정·승인 계정·승인자 명단은 기계마다 다른 팀 설정이 아니라 정책 파일의 `approval` 에서 읽는다(어느 기계에서 돌려도 같은 판정). 그리고 그 승인이 지금 head 에 달렸는지와 증거 브랜치 manifest 가 이 저장소·이 PR·지금 head 인지를 더 본다. 지원 저장소와 조건은 `scripts/pr-gate-policy.json` 에 있고, 없는 저장소는 판정하지 않는다.

```bash
skills/b3os-github-workflow/scripts/pr-gate.sh <owner/repo> <번호>
```

- `WAITING_APPROVAL`(exit 2) — 승인만 빠졌다. 작성자가 이 출력을 붙여 리뷰어에게 직접 승인을 요청한다.
- `READY`(exit 0) — 이 출력을 붙여 머지 담당에게 머지를 요청한다. 검사 통과일 뿐 머지 허가가 아니다. 팀장 승인이 필요한지는 출력의 정책 줄을 본다.
- `NOT_READY`(exit 1) · `UNKNOWN`(exit 3) — 빠진 것을 채우거나 조회를 다시 한다. 조회 실패는 통과가 아니다.
- 단위 전체는 판정한다: 증거 `run.log` 에 시험 스크립트가 찍은 `units passed N` 줄이 있고 N 이 정책의 `min_unit_tests` 이상이어야 한다. 범위 시험만 있으면 NOT_READY 다. manifest 의 통과 수는 붙인 결과 묶음만 세므로 UI 만일 수 있다.
- UI 범위(어떤 UI 클래스를 돌렸나)는 기계가 판정하지 않는다. 리뷰어가 본다.

#### 증거 manifest 형식

`pr-gate.py` 가 읽는 필드다. 증거 브랜치 최상위에 실행마다 폴더 하나를 두고 그 안에 `manifest.json` 과 `run.log` 를 넣는다.

```json
{
  "repo": "owner/repo", "pr": 12,
  "head_before": "<실행 시작 때 head 전체 sha>", "head_after": "<끝났을 때 head 전체 sha>",
  "command": "scripts/dev-check.sh", "created_at": "2026-01-15T03:04:05+00:00",
  "exit_code": 0, "result": "Passed",
  "tests": {"passedTests": 120, "failedTests": 0}
}
```

- 같은 `command` 의 실행이 여럿이면 `created_at` 이 가장 나중인 것만 본다(다시 돌려 통과시킨 경우).
- 정책에 `min_unit_tests` 가 있으면 통과한 최신 실행 가운데 하나의 `run.log` 에 `units passed N` 줄이 있고 N 이 그 값 이상이어야 한다.

#### 등록되지 않은 저장소: 손 확인

정책 파일에 없는 저장소는 게이트가 판정하지 않는다. 머지 담당이 같은 판정을 직접 조회한다. 승인 판정 규칙은 `pr-gate.py` 가 쓰는 `b3os-release-ops/scripts/approver-check.py` 와 같다: 계정마다 **가장 나중 리뷰**(submitted_at 순, COMMENTED 는 상태를 바꾸지 않으므로 건너뜀)만 본다. 승인 뒤에 같은 계정이 CHANGES_REQUESTED 를 냈으면 그 승인은 철회된 것이다. 하나라도 확인 못 하면 머지하지 않는다.

```bash
REPO=<owner/repo>; PR=<번호>
HEAD=$(gh pr view $PR -R $REPO --json headRefOid --jq .headRefOid)
# 계정별 최종 리뷰: 계정 · 상태 · commit_id · submitted_at · 본문의 마지막 비어있지 않은 줄
gh api repos/$REPO/pulls/$PR/reviews --paginate --slurp | jq -r '
  add | [ .[] | select(.state != "COMMENTED") ]
  | sort_by(.submitted_at) | group_by(.user.login) | map(last)
  | .[] | [ .user.login, .state, .commit_id, .submitted_at,
            ((.body // "") | split("\n") | map(select(test("\\S"))) | last // "" | sub("^\\s+|\\s+$"; "")) ]
  | @tsv'
gh api repos/$REPO/compare/main...$HEAD --jq .behind_by        # 0 인가
```

승인으로 세는 줄은 넷 다 맞아야 한다: ① 계정이 승인 계정 ② 상태 `APPROVED` ③ commit_id 가 `$HEAD` 와 같음 ④ 마지막 줄이 정확히 `Approved-by: <이름>` 이고 이름이 승인자 명단에 있음. 이런 줄이 0개면 승인이 없는 것이다.

- 리뷰가 버스·채팅에서만 "통과" 로 오고 GitHub 리뷰가 0건이면 승인이 아니다. 리뷰어에게 그 head 에 GitHub 승인을 걸어 달라고 한다.
- 시험 증거(그 head 의 실행 기록)는 PR 본문·증거 브랜치에서 head sha 가 맞는지 본다.
- 이 손 확인을 자주 하게 되는 저장소는 정책 파일에 등록해서 게이트가 판정하게 한다(등록은 그 저장소의 승인 규칙을 정하는 일이라 PM·팀장이 정한다).

### ⑦-1 PR 닫기 — 증거 → 승인 → 최신화 → 게이트 → 머지

승인과 시험 증거는 둘 다 **머지할 바로 그 head** 에 걸려 있어야 한다. head 가 바뀌면 둘 다 다시 받는다.

1. **증거 (작성자)** — 그 head 에서 정해진 범위를 돌리고 결과를 PR 에 붙인다. 프로젝트의 시험 스크립트가 증거 브랜치(정책의 `evidence_branch_prefix` + `<pr>-<head 앞 7자>`)에 실행마다 폴더 하나(`<run>/manifest.json`, `<run>/run.log`)를 올린다. 이 저장소는 그 스크립트를 싣지 않는다 — 형식은 아래 "증거 manifest 형식". manifest 의 시작·끝 head 가 PR head 와 같아야 유효하다.
2. **승인 (리뷰어)** — 리뷰어가 승인 계정으로 **그 head** 에 GitHub 승인을 건다(⑦ 형식). 채팅의 "통과" 는 승인이 아니다.
3. **최신화** — main 대비 `behind_by` 가 0 이어야 한다. 뒤처졌으면 rebase(또는 update-branch) → 새 head 에서 시험 다시 → 변경분 재리뷰·재승인. 다른 PR 이 먼저 머지되면 다음 PR 은 다시 뒤처진다 — 머지 순서를 정해 하나씩 닫는다.
4. **게이트** — `pr-gate.sh` 가 `READY` 거나, 등록되지 않은 저장소면 위 손 확인 세 가지가 맞는다.
5. **머지 (머지 담당)** — 승인된 head 로 고정해서 머지한다. 그 사이 누가 push 했으면 GitHub 이 거부한다.

```bash
gh pr merge <번호> -R <owner/repo> --squash --match-head-commit <승인된 head 전체 sha>
```

- 머지 방식: 기본은 squash. **출고(릴리스) PR 은 `--merge`** — squash 하면 출고 커밋(공증·태그가 가리키는 커밋)이 main 조상에서 빠진다. **외부(fork) 기여 PR 도 `--merge`** — squash 커밋에 기여자의 비공개 이메일이 박힐 수 있다.
- 게이트 결과와 머지 명령을 한 호출에 묶지 않는다(`;` 로 이으면 실패해도 머지가 돈다). 결과를 보고 다음 호출에서 머지한다.

### ⑧ 머지 후 확인

```bash
gh pr view <번호> --json state,mergedAt --jq '"\(.state) \(.mergedAt)"'
git fetch origin && git log origin/main --oneline -1
```

머지가 곧 라이브 반영은 아니다. 실행 중인 프로세스는 옛 코드로 돈다. 반영은 별도 작업이고 승인 게이트 대상이다(TEAM-OS §4).

## 공개 저장소

- `main` 에 force-push 하지 않는다. 잘못 올라간 것은 `git revert <문제커밋>` 으로 되돌린다. 태그는 옮기지 않고 새 버전을 낸다. 작업 브랜치는 rebase 후 `--force-with-lease` 가 일상이다.
- 시크릿이 올라갔을 때만 예외이고 순서가 있다: ① 키 폐기·재발급 → ② GitHub 에 캐시 제거 요청 → ③ 재작성 + `--force-with-lease`(직전에 원격 tip 확인) → ④ 사용자 공지.
- 외부(fork) PR 은 시크릿에 접근하지 못한다. `.github/workflows/` 수정은 실행 권한 변경이라 코드와 같이 리뷰한다. 계정 분리·승인자 표기는 우리 규율이라 외부 기여자에게 요구하지 않는다.

## 하지 않는 것

- 우회 경로(어느 계정이 무엇을 건너뛸 수 있는지, 어떤 동작이 검사를 안 타는지)를 공개 저장소 문서에 적지 않는다.
- 정책을 여기 복제하지 않는다. TEAM-OS 를 참조한다.
- 확인 단계를 건너뛰지 않는다. 건너뛴 확인은 "통과" 가 아니라 "모름" 이다.
- 계정을 나눠도 실질 분리는 아니다. 이 절차가 주는 것은 정확한 기록이고 우회 방지는 규율에 의존한다.

## 관련

`TEAM-OS.md` §4·§12 · `skills/b3os-infra-safety/SKILL.md` · `skills/b3os-bwf/SKILL.md`
