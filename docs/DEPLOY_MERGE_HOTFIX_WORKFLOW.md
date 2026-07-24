# 공개 정본 배포·머지·핫픽스 워크플로우

> 목적: b3os 공개 저장소(`main`)가 정본(source of truth)이 된 뒤, 팀원이 같은 기준으로 PR(풀 리퀘스트)→리뷰→clean merge→라이브 배포→인수테스트까지 끝내도록 하는 운영 정책이다.

## 원칙

1. `main`은 공개 정본이다. 라이브는 `scripts/deploy-live.sh`로 `origin/main`에 정렬한다.
2. 배포·머지·핫픽스는 채팅 합의만으로 닫지 않는다. 실제 테스트, 리뷰, 롤백 경로, 감사 로그가 있어야 닫힌다.
3. 공개 배포 전에는 secret(시크릿)·로컬 상태(`.env`, `team.db`, `agents.json`)가 공개 기록에 섞이지 않는지 확인한다.
4. 보고 시간은 팀장 로컬 시간 기준으로 쓴다. b3rys 운영 보고에서는 KST(한국 표준시)가 보이면 KST로, 로그·DB가 UTC면 변환해서 표시한다.
5. 자동화는 보조 장치다. 코드·DB·보안·배포·브랜치 보호 변경은 봇이 자율 머지하지 않는다.

## 작업 등급과 필수 조건

| 등급 | 예 | 시작 조건 | 머지/배포 전 필수 조건 | 보고·감사 |
|---|---|---|---|---|
| Routine merge | 문서, 테스트, 작은 UI 텍스트, 명백한 버그픽스 | 별도 브랜치, clean worktree | 관련 테스트/빌드, PR 리뷰 1명, 작성자 email noreply 확인, 브랜치 보호 확인 | PR 링크, 변경 파일, 검증, 미검증, 롤백 |
| Live deploy | 공개 `main`을 라이브에 반영 | `main` green, 배포 창·오너 확인 | `scripts/deploy-live.sh --dry-run`, build, launchd restart, `/team` 200, 인수테스트 | 배포 전/후 commit, 헬스체크, 롤백 commit |
| Hotfix | 운영 장애·공개 버그 긴급 수정 | 장애 범위·롤백 기준·오너 명시 | 작은 diff, 가능한 최소 테스트, member review 1명 이상, 배포 후 인수테스트 | 원인, 영향, 수정, 롤백, 후속 과제 |
| Force-push / history rewrite | 공개 기록 재작성, orphan snapshot, secret 제거 | GD 승인, 백업, freeze 공지 | 하네스 또는 2명 이상 리뷰, secret scan, branch protection/권한 확인, 복구 명령 준비 | 승인 근거, 전/후 SHA, 영향 범위, 복구 절차 |

## 표준 PR → clean merge 흐름

1. 최신 `main`에서 작업 브랜치를 만든다.
   - `git checkout main && git pull --ff-only && git checkout -b <task-branch>`
   - 공유 main 워킹트리에 직접 수정하지 않는다.
2. 구현 또는 문서 변경 후, 관련 테스트를 실행한다.
   - 코드 변경: `bun run typecheck` + 관련 테스트/스모크.
   - 문서/스킬 변경: 링크·스크립트 self-test·렌더 가능 여부 확인.
3. `skills/b3os-release-ops/scripts/release-preflight.sh --mode merge`를 실행한다.
   - clean worktree
   - `main`이 아닌 브랜치
   - `origin/main..HEAD` commit author·committer email이 GitHub noreply인지
   - `main` 브랜치 보호 설정을 GitHub API로 확인
4. PR을 열고 Bill 또는 지정 리뷰어에게 리뷰를 요청한다.
5. merge 수행 계정의 GitHub commit email(커밋 이메일)을 먼저 비공개로 고정한다.
   - GitHub Settings → Emails → “Keep my email addresses private”를 켠다.
   - 웹/squash merge는 브랜치 commit이 all-noreply여도 merge commit author·committer를 머지 수행 계정 email로 찍을 수 있다.
6. 리뷰 반영 뒤 squash/rebase 등으로 공개 기록을 정리한다. GD 명의가 필요한 공개 정본 merge는 `gd.on` noreply email로 재작성한다.
   - rebase/amend/fast-forward merge도 committer email이 로컬 실명 email로 남을 수 있으므로 author와 committer를 모두 확인한다.
7. branch protection(브랜치 보호)이 CI·리뷰·권한을 통과시키는 상태에서만 merge한다.
8. merge 후 `git fetch origin main`을 실행하고 `skills/b3os-release-ops/scripts/release-preflight.sh --mode post-merge`로 `origin/main` tip의 author·committer email이 모두 noreply인지 검증한다.
9. 검증 후 로컬 main을 fast-forward로 맞추고 필요 시 `scripts/deploy-live.sh`로 배포한다.

## 라이브 배포 흐름

`deploy-live.sh`는 공개 `origin/main`을 라이브 디렉터리에 반영하는 표준 도구다.

흐름:

1. `git fetch origin main`
2. 현재 HEAD와 `origin/main` 비교
3. `git reset --hard <target>`
4. `bun install`
5. `bun run build`
6. `launchctl kickstart -k <label>`
7. `http://127.0.0.1:<port>/team` 200 확인
8. 실패 시 이전 commit으로 자동 롤백 시도

배포 전 체크:

```bash
bash scripts/deploy-live.sh --dry-run
skills/b3os-release-ops/scripts/release-preflight.sh --mode deploy --live-dir "$PWD"
```

배포 후 인수테스트(acceptance test):

- `/team` 대시보드가 200으로 뜬다.
- `/team/api/agents`가 팀원 목록을 반환한다.
- 이번 변경의 실제 사용자 경로를 1회 이상 확인한다.
- 실패하면 `deploy-live.sh`가 출력한 이전 commit으로 롤백하거나, 수동으로 `git reset --hard <prev>; bun run build; launchctl kickstart -k ...`를 실행한다.

## 핫픽스 흐름

1. 장애·버그 증상을 한 문장으로 고정한다.
2. 영향 범위와 롤백 기준을 먼저 적는다.
3. 최신 `main`에서 `hotfix/<short-topic>` 브랜치를 만든다.
4. 변경은 최소 diff로 제한한다. 리팩터링·기능 추가를 섞지 않는다.
5. 관련 테스트와 실제 재현 경로를 확인한다.
6. member review 1명 이상을 받는다. 공개 장애·보안·데이터 영향이면 하네스 리뷰까지 붙인다.
7. merge 후 즉시 live deploy를 수행하고 인수테스트 결과를 보고한다.
8. 후속 정리(테스트 보강, 문서화, 원인 제거)는 별도 작업으로 분리한다.

## Force-push / 공개 기록 재작성

다음은 GD 승인 없이는 금지다.

- 공개 `main` force-push
- orphan single-commit snapshot으로 공개 기록 교체
- secret 제거 목적의 history rewrite
- branch protection 완화·해제

필수 조건:

1. 현재 원격 SHA와 로컬 백업 tag/branch를 남긴다.
2. secret scan을 돌리고 결과를 기록한다.
3. 공개 범위의 commit author·committer와 annotated tag tagger email이 모두 GitHub noreply인지 확인한다.
4. 최소 2명 또는 하네스 리뷰가 전/후 diff와 복구 절차를 확인한다.
5. branch protection이 재적용되어 있는지 확인한다.
6. GD 승인 메시지, 전/후 SHA, 롤백 명령을 보고에 남긴다.

## 봇 자율머지 정책

봇이 자율 머지할 수 있는 범위:

- 문서 오탈자·링크 수정
- 테스트 expectation(기대값) 정리처럼 제품 동작을 바꾸지 않는 기계적 수정
- 포맷팅·lint 자동수정
- dead comment 제거 등 low-risk(저위험) 변경

봇 자율머지 금지 범위:

- TypeScript/서버/라우팅/DB/스케줄러 등 제품 동작 코드
- DB schema(스키마)·migration(마이그레이션)
- 권한·인증·토큰·시크릿·보안 설정
- live deploy, restart, public publish
- branch protection·GitHub 설정
- force-push/history rewrite
- 결제·외부 전송·삭제 등 되돌리기 어려운 side effect

금지 범위는 GD 승인과 리뷰 게이트를 통과해야 한다. “테스트가 통과했다”는 승인 대체가 아니다.

## 기계적 가드

팀원은 머지/배포 전 아래 가드를 돌린다.

```bash
skills/b3os-release-ops/scripts/release-preflight.sh --mode merge
skills/b3os-release-ops/scripts/release-preflight.sh --mode post-merge
skills/b3os-release-ops/scripts/release-preflight.sh --mode deploy --live-dir /path/to/live/b3rys-team-os
```

가드가 확인하는 것:

- worktree가 clean인지
- merge 대상 브랜치가 `main`이 아닌지
- PR commit author·committer email이 GitHub noreply인지
- post-merge 모드에서 `origin/main` tip author·committer email이 GitHub noreply인지
- force-push 모드에서 annotated tag tagger email이 GitHub noreply인지
- GitHub `main` branch protection이 존재하는지
- deploy 대상 디렉터리가 b3rys-team-os 공개 repo인지
- 배포 전 dry-run에서 반영 대상이 명확한지

## 표준 보고 형식

```text
files changed:
verified:
unverified:
rollback:
verdict:
```

배포 보고에는 추가로 포함한다.

```text
source: origin/main <sha>
live before: <sha>
live after: <sha>
acceptance: /team 200, /team/api/agents OK, changed path checked
```
