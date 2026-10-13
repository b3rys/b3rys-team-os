---
name: b3os-release-ops
description: b3os 공개 정본 배포·PR 머지·핫픽스·force-push 안전 게이트. 팀원이 공개 main, live deploy, clean merge, GD noreply 재작성, 인수테스트, 봇 자율머지 범위를 판단할 때 invoke한다. skills/b3os-release-ops/scripts/release-preflight.sh 로 clean worktree·noreply author/committer·post-merge tip·branch protection·live repo 확인을 기계적으로 점검한다.
trigger: deploy or cut a release
---

# b3os-release-ops — 공개 배포·머지·핫픽스 게이트

정본 문서: `docs/DEPLOY_MERGE_HOTFIX_WORKFLOW.md`

## 언제 invoke하나

- b3os 공개 `main`에 PR을 merge하기 전.
- live deploy(라이브 배포)하기 전/후.
- hotfix(긴급 수정)를 만들거나 머지할 때.
- force-push/history rewrite/orphan public snapshot 같은 공개 기록 재작성 논의가 있을 때.
- 봇이 “자동 머지해도 되는가?”를 판단해야 할 때.

## 빠른 판정

| 작업 | 봇 자율 가능? | 필수 게이트 |
|---|---:|---|
| 문서 오탈자, 링크, 포맷팅 | 가능 | clean worktree, preflight, 가능하면 리뷰 |
| 테스트만 수정, 제품 동작 불변 | 제한적 가능 | 관련 테스트, preflight, 리뷰 1명 |
| 코드 동작 변경 | 불가 | PR, CI/typecheck, member review, 필요 시 harness |
| DB·권한·보안·시크릿 | 불가 | 팀장 승인, 리뷰, rollback, 감사 로그 |
| live deploy/restart | 불가 | 팀장/운영 승인, dry-run, build, acceptance, rollback |
| branch protection/force-push | 불가 | 팀장 승인, 2명 또는 harness review, backup, audit |

## 표준 실행 절차

### 1. PR merge 전

```bash
# 작업 브랜치에서
skills/b3os-release-ops/scripts/release-preflight.sh --mode merge
bun run typecheck   # 코드 변경일 때
```

확인:

- `git status`가 clean인지.
- 브랜치가 `main`이 아닌지.
- `origin/main..HEAD` commit author·committer email이 GitHub noreply인지.
- GitHub `main` branch protection이 켜져 있는지.
- PR 리뷰 1명 이상을 받았는지.

### 2. clean merge

- 공개 기록에 남길 author가 GD라면 `gd.on` noreply email로 재작성한다.
- merge 수행 계정은 GitHub Settings → Emails에서 “Keep my email addresses private”를 먼저 켠다. GitHub 웹/squash merge commit은 브랜치 commit이 all-noreply여도 머지 수행 계정의 author·committer email을 남길 수 있다.
- rebase/amend/fast-forward merge도 committer email이 로컬 실명 email로 남을 수 있으므로 author와 committer를 모두 확인한다.
- squash/rebase는 PR 범위 안에서만 한다.
- branch protection을 우회하거나 완화하지 않는다.
- merge 후 `git fetch origin main`을 실행하고 `skills/b3os-release-ops/scripts/release-preflight.sh --mode post-merge`로 `origin/main` tip author·committer email이 모두 noreply인지 확인한다.
- post-merge 검증 뒤 `main`을 fast-forward로 맞춘다.

### 3. live deploy

```bash
git fetch origin main
git --no-pager log --oneline HEAD..origin/main        # 반영될 commit 확인(dry-run)
skills/b3os-release-ops/scripts/release-preflight.sh --mode deploy --live-dir "$PWD"

PREV="$(git rev-parse HEAD)"                          # 롤백 지점 — 보고에 남긴다
git reset --hard origin/main
bun install && bun run build
bun run service restart                               # 상시가동 미등록이면 `bun run start` 재기동
```

검증(`/team` 200)이 실패하면 `git reset --hard "$PREV"` → `bun install && bun run build` → 재시작으로 되돌린다. 전체 절차와 인수테스트 기준은 `docs/DEPLOY_MERGE_HOTFIX_WORKFLOW.md`의 “라이브 배포 흐름”이 정본이다.

### 4. 배포 후 인수테스트

- `/team` 200 확인.
- `/team/api/agents` 응답 확인.
- 변경된 사용자 경로를 대표 케이스로 1회 확인.
- 보고에 before/after SHA, 검증, 미검증, rollback을 남긴다.

## Hotfix 모드

1. 증상, 영향, 롤백 기준을 먼저 적는다.
2. `hotfix/<topic>` 브랜치에서 최소 diff로 고친다.
3. 관련 테스트와 실제 재현 경로를 확인한다.
4. member review 1명 이상을 받는다. 공개 장애·보안·데이터 영향이면 harness까지 붙인다.
5. merge 후 즉시 deploy + acceptance를 수행한다.
6. 후속 정리는 별도 작업으로 분리한다.

## Force-push / history rewrite

팀장 승인 없이는 금지다. 승인 후에도 다음을 모두 만족해야 한다.

- 원격 현재 SHA 백업.
- rollback branch/tag 준비.
- secret scan 통과.
- 공개 범위 commit author·committer와 annotated tag tagger email noreply 확인.
- 2명 이상 또는 harness review.
- branch protection 재확인.
- 전/후 SHA와 복구 명령 보고.

## 버전 올리기

버전은 semver(`major.minor.patch`)로 관리한다. 직전 `vX.Y.Z` 태그 이후 원격 main에 실제로 포함된 머지 PR을 기준으로 계산한다.

- `feat`/`feature`/`기능` 제목 접두사 또는 같은 분류 라벨이 하나라도 있으면 minor를 올리고 patch를 0으로 만든다. 예: `0.6.1` → `0.7.0`.
- fix·docs·chore 등 나머지만 있으면 patch를 올린다. 예: `0.6.1` → `0.6.2`.
- 머지 PR 0건이면 파일·커밋·태그·Release 없이 종료한다. main에 직접 들어간 커밋은 PR 목록에 포함되지 않는다.
- breaking change의 major 승격은 자동 판정하지 않는다. 별도 검토 후 릴리스 정책을 결정한다.

하루 1회 사람이 다음 순서로 실행한다. 이 문서는 자동 게시나 예약 실행을 등록하지 않는다.

```bash
scripts/release-cut.sh --dry-run
# 출력한 notes 파일과 plan.json을 검토한다. 출력은 저장소 밖의 새 임시 디렉터리다.
# 노트를 고쳤으면 새 plan으로 다시 고정하고 최종 출력물을 검토한다:
scripts/release-cut.sh --dry-run --notes-file /path/to/reviewed.md
# 사람이 게시를 승인한 뒤, 검토 당시 origin/main과 일치하는 clean main에서만:
scripts/release-cut.sh --publish --approved --plan /path/to/plan.json
```

기본 모드는 dry-run이다. PR 제목은 Features/Fixes/Documentation/Maintenance로 묶고 구현 scope를 제거한다. 기존 public-content-lint와 public-lint-allow의 공개 낱말 목록을 적용하며 내부 이름·경로·회고를 포함한 제목은 공개용 일반 문구로 대체한다. 설치본의 명단·프로젝트·설정을 읽지 못하면 초안 생성은 실패한다. 자동 검사만으로 모든 내부 정보가 제거되지는 않으므로 사람이 노트를 확인한다.

publish는 검토한 plan·노트·PR 목록·main SHA가 현재 값과 일치할 때만 진행한다. 기존 release-preflight의 post-merge 검사 후 설정의 noreply 이메일로 package.json 버전 커밋과 annotated tag를 만들고 main·태그를 atomic push한 뒤 `gh release create --verify-tag`를 실행한다. 브랜치 보호를 우회하지 않는다. 보호 규칙이 push를 거부하면 중단하며 로컬 커밋·태그는 남는다. 원격 push 이후 Release 생성이 실패하면 원격 커밋·태그가 이미 존재할 수 있으므로 상태를 확인하고 승인 범위 안에서 기존 태그로 게시를 재개한다. 태그를 이동하거나 자동 삭제하지 않는다.

대시보드 하단 버전과 SHA는 `/api/version`이 반환하는 **서버 시작 시점**의 package.json과 Git HEAD다. 머지·파일 변경만으로 표시가 바뀌지 않으며 재시작이 필요하다. 배포·재시작 승인은 게시 승인과 별개다.

시험: `bun test scripts/release-plan.test.ts scripts/release-cut.test.ts scripts/release-publish.test.ts src/server/routes/version.test.ts src/web/components/RunningVersion.test.ts`.

## 기계적 가드 (명령)

`release-preflight.sh`:

```bash
skills/b3os-release-ops/scripts/release-preflight.sh --mode merge
skills/b3os-release-ops/scripts/release-preflight.sh --mode post-merge
skills/b3os-release-ops/scripts/release-preflight.sh --mode deploy --live-dir /path/to/live/repo
```

옵션:

- `--mode merge|deploy|hotfix|force-push|post-merge`
- `--base origin/main`
- `--live-dir <path>`
- `--skip-branch-protection` (GitHub API를 쓸 수 없는 로컬 dry-run 때만)
- `--allow-main` (deploy 모드처럼 main worktree 검사가 필요한 때만)

실패하면 머지/배포하지 말고 원인을 해결한다. `--skip-*` 옵션 사용은 보고에 남긴다.

## 보고 템플릿

```text
files changed:
verified:
unverified:
rollback:
verdict:
```

배포면 추가:

```text
source: origin/main <sha>
live before: <sha>
live after: <sha>
acceptance:
```
