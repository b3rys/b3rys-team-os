# Projects 탭 — 계약 (착수 기준)

Projects는 Reports와 목록·상세 스타일을 공유한다. 목록에서 프로젝트를 선택하면 트랙별 문서와 현재 과제를 보여 준다. 문서는 GitHub의 Markdown을 HTML로 표시하며 원문 전환도 제공한다.

원칙: 원본은 GitHub md. 서버는 등록정보만 갖고 렌더는 파생본(캐시). 같은 사실을 두 곳에 다른 값으로 적지 않는다.

## 0. 세 가지의 관계 — 프로젝트 · 칸반 카드 · 원본 md

```
GitHub 저장소 (원본)                        team.db (원본)                    Projects 탭 (뷰)
 ├ README.md   무엇인가 · 소개              task 카드                          ├ 목록 줄: 이름·소개·건수·최근 조회
 ├ DESIGN.md   구조 (다이어그램)             ├ title "[sample] 핵심코드 리뷰…"      ├ 문서 화면: md → HTML (MD 토글)
 ├ FEATURES.md 지금 되는 것 (사용자 관점)     ├ lane plan|doing|done            └ 현재 상태: TODO [~]/[ ]/[x] + 칸반 plan/doing
 └ TODO.md     할 일·상태 (작업 관점)         └ description 다음 액션
        ▲                                        ▲
        │ 팀장 지시·결함·킵은 여기 (정본)            │ "지금 하는 큰 과제" 한 장 (정본)
        └──────────── 같은 사실을 두 곳에 다른 값으로 적지 않는다 ────────────┘
```

- **프로젝트** = 저장소 하나 또는 여러 트랙 + 등록정보(설치본의 `projects.json` 한 줄). 정체성은 `id`.
- **원본 md** = 저장소의 네 문서. Projects 탭은 ★읽기만★ 한다 — 고치는 곳은 GitHub(PR). 렌더·캐시는 파생본.
- **칸반 카드** = 그 프로젝트의 "지금 하는 큰 과제". TODO 항목 하나하나가 카드가 아니다. 연결은 카드 제목의 접두 `[<id>]` (`kanbanPrefix`) — 추가 필드 없이 지금 쓰는 관습 그대로.
- **상태 두 축**: TODO.md 의 `[~]/[ ]/[x]` 는 항목 상태(세밀), 칸반 lane 은 과제 상태(굵음). 탭은 둘을 나란히 보여 주고 합치지 않는다.
- **흐름**: 팀장 지시 → TODO.md 항목(정본) → 큰 과제면 칸반 카드 → 구현 → TODO `[x]` + 카드 done → 기능이 바뀌었으면 FEATURES 갱신(작업 근거는 TODO 에 남긴다). 정본은 `b3os-sf` 스킬.

## 1. 등록정보 — `projects.json` (저장소 루트, ★설치본마다 따로 · git 추적 안 함★)

`agents.json` 과 같다 — 각 머신 고유 상태라 저장소에 올리지 않는다(공개 repo 에 다른 팀의 비공개 저장소 이름이 나가면 안 된다). 파일이 없으면 빈 목록이고 탭에 "등록된 프로젝트가 없습니다" 가 뜬다. 형식은 `projects.example.json` 을 복사해 쓴다.

```json
[
  {
    "id": "sample",
    "name": "Sample",
    "repo": "your-org/sample",
    "branch": "main",
    "docs": { "readme": "README.md", "design": "DESIGN.md", "features": "FEATURES.md", "todo": "TODO.md" },
    "kanbanPrefix": "[sample]",
    "excludeSections": ["킵", "선택 대기", "답 대기", "승인 대기"]
  }
]
```

- `docs` 키 4개는 고정(없는 파일은 화면에서 비활성). `kanbanPrefix` = 칸반 `task.title` 이 이걸로 시작하면 이 프로젝트의 과제.
- `excludeSections`(선택) = TODO.md 헤더 줄에 이 문자열 중 하나가 들어가면(부분 문자열 일치) 그 절의 `[ ]` 는 plan 에서 뺀다. 없으면 기본값 `["킵"]`. 이 목록이 정본이다 — 코드에 절 이름을 두지 않고, 서버가 API 응답에 실어 화면도 그것만 쓴다.

### 다중 트랙 (선택)

`tracks`를 추가하면 배열의 각 항목을 독립 저장소로 읽는다. 전체 예시는 `projects.example.json`에 있다. 단일 저장소 등록은 변경 없이 동작한다. 트랙 등록은 상위 `repo`·`docs`·`kanbanPrefix` 없이도 가능하며 `tracks`가 있으면 트랙 배열이 조회 대상을 결정한다.

- 트랙 필수 값: `name`, `repo`, `docs`. 트랙의 `docs`에는 있는 문서만 등록한다(최소 한 개). 키와 경로 검증은 단일 저장소와 같다. 단일 저장소 형식은 기존대로 README·DESIGN·FEATURES·TODO와 비어 있지 않은 `kanbanPrefix`가 필수다.
- `id`는 선택이며 생략하면 배열 인덱스 문자열을 쓴다. 문서 주소를 유지하려면 명시한 ID를 유지한다.
- `branch`는 트랙 → 프로젝트 → `main`, `tokenEnv`는 트랙 → 프로젝트 → `GITHUB_TOKEN` 순으로 적용한다. `excludeSections`도 트랙 값이 우선한다.
- 트랙의 `kanbanPrefix`를 지정한 경우에만 이 설치본의 칸반을 읽는다. 생략하면 해당 저장소 TODO.md의 `[~]` 줄만 지금 과제에 표시한다. 다른 트랙의 칸반은 섞지 않는다.
- 목록·상세 응답의 `tracks`에는 성공한 트랙의 문서·건수·현재 과제 또는 실패한 트랙의 `{ id, name, repo, error, key }`가 순서대로 들어간다. 상위 건수는 성공한 트랙들의 합계다. 최상위 `repo`·`branch`는 첫 등록 트랙에 고정한다. 첫 트랙을 조회하지 못하면 최상위 `sha`·`intro`는 빈 문자열, `docs`는 첫 트랙의 등록 문서를 `exists: false`로 표시한다. 다른 트랙의 커밋·문서를 최상위에 섞지 않는다.
- 문서 JSON·원문·독립 페이지는 `?track=<id>`로 트랙을 선택한다. 생략하면 첫 트랙을 선택하며 알 수 없는 ID는 404다. 문서 내부 링크·새창 칩에도 선택한 트랙을 유지한다.
- 한 트랙이 실패해도 성공한 트랙은 표시한다. 전부 실패하고 캐시도 없으면 502다. 새로 조회 시에도 트랙별 캐시와 오류 처리를 적용한다.

## 2. 서버 API (Hono, `/team` 아래 — 기존 rewrite 그대로)

| 메서드·경로 | 반환 | 비고 |
| --- | --- | --- |
| `GET /api/projects` | `{ projects: [ProjectSummary] }` | 목록 화면 한 번에 |
| `GET /api/projects/:id` | `ProjectSummary` | |
| `GET /api/projects/:id/doc/:key` | `{ id, key, sha, path, html, md, title, toc: [{level,text,anchor}] }` | `key ∈ readme·design·features·todo` · `todo` 는 `current: { doing, plan, done, doingTitles, items, excludeSections }` 추가 |
| `GET /api/projects/:id/doc/:key/raw` | `text/markdown` | MD 토글 |
| `POST /api/projects/:id/refresh` | `{ sha }` | 캐시 무효화(수동) · `requireActor` |

```ts
type ProjectSummary = {
  id: string; name: string; repo: string; branch: string; sha: string;   // sha = 렌더 기준 commit
  intro: string;                       // README 첫 문단 (200자)
  docs: { key: "readme"|"design"|"features"|"todo"; path: string; exists: boolean }[];
  todo: { doing: number; plan: number; done: number; doingTitles: string[] };   // TODO.md 파싱
  excludeSections: string[];           // 등록정보 그대로(없으면 ["킵"]) — 화면의 TODO 파싱도 이 목록만 쓴다
  kanban: { id: string; title: string; lane: "plan"|"doing"; updatedAt: string }[]; // team.db task, prefix 일치, done 제외
  fetchedAt: string;
};
```

- GitHub 원본: `https://raw.githubusercontent.com/<repo>/<sha>/<path>`. sha 는 `GET repos/<repo>/branches/<branch>` 를 ★60초★ TTL 로 재확인. 네 문서를 ★같은 sha★ 로 읽는다.
- 캐시 키 = `repo + sha + path + RENDERER_VERSION`. 저장은 `var/projects-cache/` (git 밖). 파생본이다 — 편집 원본이 아니다.
- private repo: 토큰은 서버 env 만(로그·응답에 안 나감). ★어느 env 이름을 쓸지★는 항목의 `tokenEnv`(기본 `GITHUB_TOKEN`) — 값은 팀서버 루트 `.env`(gitignore)에, 프로젝트마다 `GITHUB_TOKEN_<ID>` 로 나눈다. 공개 repo 는 `tokenEnv` 없이 무인증. 문서 응답도 `/team` 의 기존 열람 규칙을 따른다 — 토큰 숨기는 것만으로 문서 공개를 막지 못한다.
- 실패 동작: GitHub 401/404/네트워크 → 캐시가 있으면 캐시 + `stale: true`, 없으면 `{ error, key }` 502. 목록은 절대 빈 값으로 덮지 않는다(iCloud 교훈). `error` 는 브랜치 조회가 401/403/404 면 `github_auth_or_not_found`(토큰·저장소·브랜치 문제), 그 밖(네트워크·5xx)은 `github_unavailable`.

## 3. 렌더 (서버, 공통 렌더러 `src/server/lib/projectDocRender.ts`)

- Markdown → HTML: 기존 `skills/b3os-report/scripts/render.mjs` 를 옮겨 쓰지 말고 ★서버 모듈로 재작성★(zero-dep 유지: 헤딩·표·목록·인용·코드펜스·링크·이미지·체크박스·취소선).
- ```mermaid 블록 → 서버에서 SVG 로 변환해 인라인 (`@mermaid-js/mermaid-cli` 는 크롬 의존이라 ★쓰지 않는다★ — 우선 `beautiful-mermaid` 류 zero-dep 렌더러가 있으면 그것, 없으면 ★1차: `<pre class="mermaid-src">` 로 코드 그대로 + "다이어그램 렌더 예정" 배지★ 하고 `needs` 에 적는다. 보고서 iframe 의 실행 권한은 풀지 않는다).
- 상대 링크·이미지: `[x](docs/y.md)` → 같은 프로젝트 문서면 `?view=projects&id=sample&doc=…`, 아니면 GitHub blob URL.
- 원문 HTML 은 정제(script·on* 제거).
- TODO 파싱 규칙(`b3os-sf` TODO.md 모양): 줄 시작 `- [~]` doing · `- [ ]` plan · `- [x]` done. ★제외 절★(헤더 줄에 등록정보 `excludeSections` 의 문자열이 들어가는 절 — 기본 `킵`; sample 는 `킵`·`선택 대기`·`답 대기`·`승인 대기`)의 `[ ]` 는 plan 에서 뺀다 — 착수 예정으로 오인하지 않게. 하위 헤더까지 이어지고 형제 헤더에서 풀린다. `doingTitles` = `[~]` 줄의 첫 60자. "이번 주 완료" 는 안 센다(완료일 필드 없음).

## 4. 화면 (`src/web/components/Projects.ts`, Reports 와 같은 자리·같은 스타일)

- 탭: 상단 `global-reports-tab` 옆에 `global-projects-tab`. `/team?view=projects`. 별도 링크 `/projects` → 302 `/team?view=projects` (gate rewrite 한 줄 + 서버 redirect).
- 목록 카드: 이름·두 줄까지 소개, 트랙별 진행·계획·완료 숫자와 얇은 완료 비율 막대, 문서 버튼·GitHub·최근 조회 시각. Reports와 색 토큰·목록 여백을 공유한다.
- 지금 과제는 트랙별 상위 3줄을 보이고 나머지는 `+N`으로 펼친다. 접두 이모지와 마크다운 장식을 정리하고 화면에서는 한 줄 말줄임으로 표시하며 전체 문장은 title에 보존한다.
- 별도 상세 화면 없이 문서 버튼에서 문서를 바로 연다. 기존 `?id=sample` 링크와 문서의 `← 목록`은 해당 카드로 스크롤한다. 카드 테두리는 모두 같은 연한 중립 색을 사용한다. `doc`·`track`·`sec` 문서 링크는 유지한다.
- 카드 이름·소개 영역을 누르면 첫 트랙의 PROJECT 문서를 연다. PROJECT가 없으면 README를 연다.
- 문서 상단: 목록 복귀·프로젝트/트랙/파일명·선택 상태가 구분되는 네모 문서 칩·HTML/MD·GitHub/새창 아이콘. 좁은 영역에서는 줄을 나눠 조작을 유지한다.
- 넓은 영역에서는 목차 210px를 왼쪽에 붙이고 본문은 남은 폭을 채우되 76em(기본 약 1100px)으로 제한한다. 글자 크기가 커지면 본문 상한도 늘어난다. 실제 문서 내용 영역이 900px 미만이면 목차를 본문 위 접이식으로 옮기며 본문은 최대 760px다. 넓은 영역에서는 목차가 sticky로 따라온다.
- 화면 크기는 Settings의 전체 대시보드 배율 또는 어느 탭에서든 `⌘−`/`⌘=`/`⌘0`으로 90·100·110·125·150%를 조절한다. 루트에 한 번 적용하며 localStorage 저장이 막혀도 조절은 동작한다. TODO는 현재 상태/전체 탭을 유지한다.

## 5. 파일 소유권

| 담당 | 쓰는 파일 |
| --- | --- |
| 서버 | `projects.json` · `src/server/routes/projects.ts` · `src/server/lib/projectDocRender.ts` · `src/server/lib/projectTodo.ts` · `src/server/lib/githubDocs.ts` · 그 테스트 · `src/server/index.ts` 의 route 2줄(`api.route` + `/projects` redirect) |
| 화면 | `src/web/components/Projects.ts` · `MetricsBar.ts` 의 탭 버튼 · `main.ts` 의 view 등록(`VALID_MAIN_VIEWS`·렌더 분기) · `MobileTabBar.ts` · 스타일 |
| 게이트 | `~/Development/b3rys-gate/next.config.ts` rewrite 1줄 (`/projects` → 7878) — 오케스트레이터 |
| 검증 | `tests/` 아래 새 파일 · `docs/PROJECTS_TAB.md` §6 |

## 6. 수용 기준 (검증자가 잰다)

1. `GET /api/projects` 에 sample 1건, 4문서 exists, todo 건수가 TODO.md 를 직접 센 값과 같다, kanban 에 `[sample]` 카드.
2. DESIGN 문서 HTML 에 헤딩 toc 와 mermaid 6개가 (SVG 또는 코드+배지로) 모두 자리한다 — 빠진 것 0.
3. TODO "현재 상태" 에 킵 절 항목이 plan 으로 안 센다.
4. sha 갱신: 브랜치 sha 가 바뀌면 60초 안에 새 렌더, 그 전엔 캐시.
5. GitHub 실패 시 캐시 유지 + stale 표시, 목록 비지 않음.
6. `/projects` 직접 접속 → Projects 화면. 모바일 폭(390)에서 가로 스크롤 없음.
7. 기존 Reports 탭 회귀 0 (`bun test` 전체 + 기존 reports 테스트).
8. 토큰이 응답·로그에 안 나온다.

### §6 측정 결과 (검증자) · `a2c5a671`

격리 서버 `TEAM_HTTP_PORT=7899` + team.db 사본, 원본 md 는 `your-org/sample` 를 replay(sha `6d2cce35`)·실조회(sha `c5b9a01`) 둘로 읽었다.

| # | 어떻게 쟀나 | 값 | 판정 |
| --- | --- | --- | --- |
| 1 | replay 로 `GET /team/api/projects` · TODO.md 를 별도 파서로 직접 셈 · team.db 사본 `select` | sample 1건 · 4문서 exists · todo 30/50/153 = 직접 센 값 · kanban 3건 = DB `[sample]` plan·doing 3건 | 통과 |
| 2 | DESIGN md 헤딩 수 vs `toc` · ```mermaid 수 vs `<figure class="project-diagram">` · 원문에 `<script>`·`onerror` 주입 후 렌더 | 헤딩 29=29 · mermaid 6=6(figure·mermaid-src·배지 각 6) · script 0 onerror 0 | 통과 |
| 3 | `/doc/todo` 의 `current.items` 를 section 별로 셈 | 킵·선택 대기·답 대기·승인 대기 절의 plan 0건 (제외 12건) | 통과 |
| 4 | `githubDocs.test.ts` TTL 케이스 + 뮤턴트(60_000→600_000) | 59,999ms 캐시·60,000ms 재조회 통과 · 뮤턴트 2 fail | 통과 |
| 5 | 토큰 dummy 로 띄워 실제 502 · 캐시 있는 상태로 재기동 → stale · 화면 사진 | 502 `{"error":"github_unavailable","key":"branch"}` · 재기동 후 200 `stale:true` 목록 1건 · 화면=오류 문구+다시 시도 / stale 배지 | 통과 |
| 6 | `curl -i /projects` · headless Chrome CDP 390 에뮬레이션 | 302 → `/team?view=projects` · 목록·DESIGN·TODO 세 화면 `scrollWidth` 390=390, 넘치는 요소 0 · toc 접힘 버튼 | 통과 |
| 7 | `bun run typecheck` · `bun test` 전체 · Reports 탭 사진 | tsc 0 · 3151 pass / 0 fail / 8 skip (254 파일, personaPathSafety 14/14) · Reports 80건 정상 | 통과 |
| 8 | `GITHUB_TOKEN=dummy-test-token` 으로 띄워 5개 경로 요청 뒤 로그·응답·캐시 파일 grep · `tests/projects/github-token.test.ts` | `dummy-test-token`/`ghp_`/`github_pat_`/`Authorization` 0건 · 헤더에는 실림(뮤턴트로 확인) | 통과 |

- 참고: 측정 당시 제외 절은 코드의 정규식이었고, `답 대기` 절(6건)이 §3 문구에 없었다(문구 기준 plan 56, 구현 50). 그 뒤 제외 절을 `projects.json` 의 `excludeSections` 로 옮겼다 — 위 값은 그 목록과 같은 네 절 기준이다.
- 뮤턴트 5종 모두 테스트 FAIL: TTL 600초(2) · 킵 제외 제거(3) · 정제 제거(1) · 화면 실패→빈 목록(4) · 토큰 헤더 제거(2).
