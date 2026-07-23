# Team Learning Log (SHARED.md)

> 팀이 작업하며 얻은 교훈을 append-only로 기록 (날짜·케이스·교훈·반영처·상태).

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
