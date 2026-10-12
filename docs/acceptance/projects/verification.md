# Projects 목록·트랙 검증

- 접근: `/team/?view=projects` → 프로젝트 선택 → 트랙 문서 칩.
- 구현: `src/web/components/Projects.ts`, `BrowseStyles.ts`, `Reports.ts`; 서버 `githubDocs.ts`, `routes/projects.ts`; 문서 링크 `projectDocRender.ts`, `shared/projectsProse.ts`.
- 자동 검사: 단일 저장소 호환·트랙별 집계·선택 문서/원문/새창·토큰 오류 격리·화면 전환·Reports 공통 스타일 회귀. 실행 명령:

```sh
bun test src/server/routes/projects*.test.ts src/server/lib/githubDocs.test.ts src/server/lib/project*.test.ts src/web/components/projects.test.ts tests/projects src/web/components/reports*.test.ts
bun run typecheck
bun run build
```

- 결과: 128개 통과, 0개 실패. 타입 검사·웹 빌드 통과(큰 청크 경고 있음).
- 변이 검증: 모든 트랙 조회를 첫 저장소로 돌리도록 바꾸면 트랙 시험 9개 중 8개 실패. 원복 후 9개 통과.
- 화면 검증: `bun run scripts/check-projects-ui.ts`는 DB를 메모리에, 캐시를 임시 폴더에 두고 GitHub 응답을 sample 데이터로 대체한다. Vite는 18912, API는 18913 포트를 사용한다. 서버는 라이브 registry·DB·토큰을 읽지 않는다.
- 브라우저: 1440×900·390×844에서 목록 3행, 다중 트랙 상세 2절, 단일 저장소 상세 1절을 확인했다. 소개는 두 폭 모두 한 줄이며 상세 영역의 가로 넘침은 0이다. 390px Mobile TODO 문서가 해당 트랙 과제를 표시하며 문서 영역의 가로 넘침도 0이다. 일부 실패·다크 테마 캡처 포함.
- 미검증: 실제 비공개 저장소 및 설치본 토큰 권한, 라이브 등록·배포. 격리 서버는 Projects API만 제공하므로 주변 팀 상태 조회·WebSocket은 연결하지 않는다.

| 화면 | 데스크톱 | 390px |
| --- | --- | --- |
| 목록 | [PNG](screenshots/list-desktop.png) | [PNG](screenshots/list-mobile.png) |
| 상세 | [PNG](screenshots/detail-desktop.png) | [PNG](screenshots/detail-mobile.png) |
| 일부 실패 | [PNG](screenshots/partial-desktop.png) | [PNG](screenshots/partial-mobile.png) |

[다크 상세](screenshots/detail-dark.png) · [390px 문서](screenshots/document-mobile.png)

## 등록·캐시·대표 트랙 회귀

- 단일 형식 `kanbanPrefix` 누락·빈 문자열·잘못된 타입은 거부하고 트랙 생략은 허용하는 시험을 추가했다. 필수 검사를 제거하는 변이는 이 시험 1개가 실패한다.
- 같은 repo/SHA/문서 경로를 공유하는 두 프로젝트·두 트랙을 순차 조회하고, 재시작 후 오프라인 캐시도 조회했다. 기존 구현에서 링크 오표시는 재현되지 않았다. 불변 문서 캐시는 원문을 공유하고 현재 등록정보로 HTML을 다시 렌더링하며, snapshot 캐시는 프로젝트 ID·트랙을 포함한다. 캐시 HTML을 바로 재사용하도록 바꾸는 변이는 새 회귀 시험 1개가 실패한다. 다른 저장소의 동일 README.md 경로도 서로 다른 원문을 유지한다.
- 첫 트랙 401에서 최상위 repo가 두 번째 트랙으로 바뀌는 오류를 새 시험으로 재현했다(수정 전 1 fail). 수정 후 목록·상세에서 첫 트랙 repo를 유지하며 다른 트랙 SHA/문서를 빌려오지 않는다.
- 트랙은 README·PROJECT·TODO만 등록해도 조회되고, 미등록 DESIGN·FEATURES는 GitHub 요청·독립 페이지·화면 탭에서 제외된다. 단일 형식의 필수 문서 조건은 유지한다.
