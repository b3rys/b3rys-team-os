# Team Learning Log (SHARED.md)

> 팀이 작업하며 얻은 교훈을 append-only로 기록 (날짜·케이스·교훈·반영처·상태).

## 2026-07-26 — HOME 격리는 절반이다: 프로세스 밖 전역 자원은 HOME 이 안 닿는다

- 케이스: 하루에 같은 병이 두 번 나왔다. ①`uninstall.sh` 를 HOME 격리 fixture 로 돌렸더니 라이브 `team-collab`·`team-os-boot`·hermes 게이트웨이가 bootout 됐다 — launchd 라벨은 `gui/$UID` 사용자 전역이라 HOME 과 무관하다. 기존 가드는 "plist 가 없으면 bootout 은 어차피 no-op" 이라 가정했는데 그 가정이 틀렸다. ②`bot-liveness-monitor.sh` 의 재현 하네스가 HOME·tmux 를 격리했는데도 라이브 상태 마커를 덮어썼다 — 상태 파일 경로가 절대경로 `/tmp/...` 였다. 하필 그 사고를 4시간 방치시킨 thrash 가드를, 그 사고의 재현 테스트가 켜버렸다.
- 교훈: 격리를 설계할 때 **"이 자원이 HOME 아래 있는가"** 를 먼저 묻는다. launchd 라벨·절대경로 상태파일·포트·소켓·시스템 키체인·cron 은 HOME 이 닿지 않는다. 소유 판별은 "남의 것이라는 증거가 없다"(fail-open)가 아니라 **"내 것임이 증명된다"**(fail-closed)를 기준으로 한다. 지적받은 경로 1개만 고치지 말고 전수로 훑는다(실제로 1개인 줄 알았으나 6개였다).
- 검증법: "안 건드렸을 것이다" 가 아니라 **실행 전후 라이브 파일들의 mtime·크기 지문을 diff** 해서 불변을 실측한다. 그리고 격리를 넣은 뒤에는 **수정을 되돌린 뮤턴트로 하네스가 여전히 결함을 잡는지** 확인한다 — 격리가 통과율만 올린 게 아님을 세우려면 이 단계가 필요하다.
- 반영처: `uninstall.sh`(PR#53, 행위 테스트 포함) · `bot-liveness-monitor.sh`(`LIVENESS_STATE_DIR`, 커밋 adfdf11) · 테스트 격리 설계 일반.
- 상태: 확정 — 2026-07-26 두 사례 모두 실측·교차검증 완료(bill 수정, steve 독립 검증).

## 2026-07-24 — 상태 경고는 실제 생존성과 데이터 형식부터 확인

- 케이스: 에이전트 `응답 지연` 경고가 표시됐지만 실제 bridge/runtime은 살아 있었다. 한 사례는 JSON PID marker를 legacy 숫자 PID로 읽은 writer/reader 형식 불일치였고, 다른 사례는 10초 응답 대기시간을 넘긴 뒤 정상 완료한 호출이었다.
- 교훈: 상태 배너만으로 장애를 단정하지 않는다. 실제 프로세스·runtime 응답, 상태 writer/reader 포맷, timeout 이후 완료 여부를 순서대로 확인한 뒤 장애/지연/표시 오류를 구분한다.
- 반영처: 장애 진단·health UI 검증 시 재사용할 팀 지식.
- 상태: 관측됨 — 2026-07-17, 2026-07-19 두 사례.

## 2026-07-24 — macOS 서명 성공과 배포 가능은 별도 완료 조건

- 케이스: `codesign --verify --strict`와 hardened runtime 검증을 통과한 앱도 notarization ticket이 없어 Gatekeeper에서 차단됐다. `b3os-notary` keychain profile 부재로 notarize → staple → Gatekeeper 검증을 완료하지 못했다.
- 교훈: macOS 외부 배포 완료 기준은 서명만이 아니라 `codesign` 검증, notarization, staple, `spctl`/Gatekeeper 확인, 최종 ZIP 재검증까지 포함한다. notarization credential/profile은 값을 노출하지 않고 존재·접근 가능 여부만 사전 점검한다.
- 반영처: macOS 앱 배포·릴리스 체크리스트 후보.
- 상태: 반복 관측됨 — 2026-07-21, 2026-07-23.

## 2026-07-24 — 변형 산출물 변경 시 비대상 불변성도 검증

- 케이스: dev 앱 아이콘·bundle 변경 작업에서 public 앱의 소스/번들 아이콘 hash와 bundle id가 그대로인지 함께 확인했다.
- 교훈: dev/public, internal/external처럼 변형이 공존하는 작업은 대상 산출물의 성공만 보지 않는다. 비대상 변형의 핵심 식별자와 artifact hash가 바뀌지 않았음을 검증해야 변형 간 누출을 조기에 잡을 수 있다.
- 반영처: 멀티 변형 빌드·릴리스 검증 패턴.
- 상태: 관측됨 — 2026-07-23.

## 2026-07-24 — 라이브 트리 정본 경로 = b3rys-team-os (구 team-collab)

- 케이스: 여러 팀원(데미스·헤르메스·코덱스 등)이 계속 옛 `b3rys-team-collab`에서 git 작업·PR을 만들어 wrong-repo 사고 반복. 근본은 각 팀원 개인 memory에 옛 team-collab 경로가 라이브로 박혀 있어서다. 공유 문서(TEAM-OS·rules·README)엔 stale 경로 없음(STATE.md의 team-collab은 공개 템플릿 placeholder).
- 교훈: b3os 라이브 트리 = `~/Development/b3rys-team-os`. 모든 신규 작업(git·PR·team.db·send.sh·skills·리포트)은 여기서. `b3rys-team-collab`은 은퇴한 옛 리포지토리(리포트 데이터 심링크 원본으로만 보관, 신규 작업 금지). 세션 시작 캐시가 옛 경로를 보일 수 있으니 각자 memory의 라이브 경로를 team-os로 갱신하고, 작업 전 `git remote -v`로 정본 확인.
- 반영처: 온보딩·팀원 memory·wrong-repo 방지. 공유 항상로드 문서엔 라이브 경로를 못박을 자리가 없어(TEAM-OS=룰, STATE=온디맨드) 개인 memory가 사실상 authoritative — 갱신 필요.
- 상태: 반복 관측됨 — 2026-07-18 ~ 2026-07-24.
