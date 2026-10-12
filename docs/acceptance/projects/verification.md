# Projects 목록·트랙 검증

- 접근: `/team/?view=projects` → 프로젝트 선택 → 트랙 문서 칩.
- 구현: `src/web/components/Projects.ts`, `BrowseStyles.ts`, `Reports.ts`; 서버 `githubDocs.ts`, `routes/projects.ts`; 문서 링크 `projectDocRender.ts`, `shared/projectsProse.ts`.
- 자동 검사: 단일 저장소 호환·트랙별 집계·선택 문서/원문/새창·토큰 오류 격리·화면 전환·Reports 공통 스타일 회귀. 실행 명령:

```sh
bun test src/server/routes/projects*.test.ts src/server/lib/githubDocs.test.ts src/server/lib/project*.test.ts src/web/components/projects.test.ts tests/projects src/web/components/reports*.test.ts
bun run typecheck
bun run build
```

- 결과: 122개 통과, 0개 실패. 타입 검사·웹 빌드 통과(큰 청크 경고 있음).
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
