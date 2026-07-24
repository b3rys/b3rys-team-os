---
name: b3os-release-ops
description: b3os 공개 정본 배포·PR 머지·핫픽스·force-push 안전 게이트. 팀원이 공개 main, live deploy, clean merge, GD noreply 재작성, 인수테스트, 봇 자율머지 범위를 판단할 때 invoke한다. scripts/release-preflight.sh 로 clean worktree·noreply author·branch protection·live repo 확인을 기계적으로 점검한다.
---

# b3os-release-ops — 공개 배포·머지·핫픽스 게이트

정본 문서: `docs/DEPLOY_MERGE_HOTFIX_WORKFLOW.md`

## 언제 invoke하나

- b3os 공개 `main`에 PR을 merge하기 전.
- `scripts/deploy-live.sh`로 live deploy(라이브 배포)하기 전/후.
- hotfix(긴급 수정)를 만들거나 머지할 때.
- force-push/history rewrite/orphan public snapshot 같은 공개 기록 재작성 논의가 있을 때.
- 봇이 “자동 머지해도 되는가?”를 판단해야 할 때.

## 빠른 판정

| 작업 | 봇 자율 가능? | 필수 게이트 |
|---|---:|---|
| 문서 오탈자, 링크, 포맷팅 | 가능 | clean worktree, preflight, 가능하면 리뷰 |
| 테스트만 수정, 제품 동작 불변 | 제한적 가능 | 관련 테스트, preflight, 리뷰 1명 |
| 코드 동작 변경 | 불가 | PR, CI/typecheck, member review, 필요 시 harness |
| DB·권한·보안·시크릿 | 불가 | GD 승인, 리뷰, rollback, 감사 로그 |
| live deploy/restart | 불가 | GD/운영 승인, dry-run, build, acceptance, rollback |
| branch protection/force-push | 불가 | GD 승인, 2명 또는 harness review, backup, audit |

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
- `origin/main..HEAD` commit author email이 `@users.noreply.github.com`인지.
- GitHub `main` branch protection이 켜져 있는지.
- PR 리뷰 1명 이상을 받았는지.

### 2. clean merge

- 공개 기록에 남길 author가 GD라면 `gd.on` noreply email로 재작성한다.
- squash/rebase는 PR 범위 안에서만 한다.
- branch protection을 우회하거나 완화하지 않는다.
- merge 후 `main`을 fast-forward로 맞춘다.

### 3. live deploy

```bash
bash scripts/deploy-live.sh --dry-run
skills/b3os-release-ops/scripts/release-preflight.sh --mode deploy --live-dir "$PWD"
bash scripts/deploy-live.sh
```

`deploy-live.sh`는 실패 시 이전 commit으로 자동 롤백을 시도한다. 그래도 실패하면 출력된 수동 복구 명령을 따른다.

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

GD 승인 없이는 금지다. 승인 후에도 다음을 모두 만족해야 한다.

- 원격 현재 SHA 백업.
- rollback branch/tag 준비.
- secret scan 통과.
- 2명 이상 또는 harness review.
- branch protection 재확인.
- 전/후 SHA와 복구 명령 보고.

## 기계적 가드

`release-preflight.sh`:

```bash
skills/b3os-release-ops/scripts/release-preflight.sh --mode merge
skills/b3os-release-ops/scripts/release-preflight.sh --mode deploy --live-dir /path/to/live/repo
```

옵션:

- `--mode merge|deploy|hotfix|force-push`
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
