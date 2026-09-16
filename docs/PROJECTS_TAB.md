# Projects 탭 — 계약 (착수 기준)

팀장 지시: 보고서와 동급의 Projects 탭. 프로젝트 목록에 주요 정보(GitHub · DESIGN · FEATURES · TODO · 지금 과제)를 보이고, 링크를 누르면 GitHub 의 md 를 보기 좋은 HTML 로(기본 HTML, MD 토글). 별도 링크로도 제공. 첫 대상 = steno.

원칙: 원본은 GitHub md. 서버는 등록정보만 갖고 렌더는 파생본(캐시). 같은 사실을 두 곳에 다른 값으로 적지 않는다.

## 0. 세 가지의 관계 — 프로젝트 · 칸반 카드 · 원본 md

```
GitHub 저장소 (원본)                        team.db (원본)                    Projects 탭 (뷰)
 ├ README.md   무엇인가 · 소개              task 카드                          ├ 목록 줄: 이름·소개·문서 칩·건수·지금 과제
 ├ DESIGN.md   구조 (다이어그램)             ├ title "[steno] 핵심코드 리뷰…"      ├ 문서 화면: md → HTML (MD 토글)
 ├ FEATURES.md 지금 되는 것 (사용자 관점)     ├ lane plan|doing|done            └ 현재 상태: TODO [~]/[ ]/[x] + 칸반 plan/doing
 └ TODO.md     할 일·상태 (작업 관점)         └ description 다음 액션
        ▲                                        ▲
        │ 팀장 지시·결함·킵은 여기 (정본)            │ "지금 하는 큰 과제" 한 장 (정본)
        └──────────── 같은 사실을 두 곳에 다른 값으로 적지 않는다 ────────────┘
```

- **프로젝트** = 저장소 하나 + 등록정보(`projects.json` 한 줄). 정체성은 `id`.
- **원본 md** = 저장소의 네 문서. Projects 탭은 ★읽기만★ 한다 — 고치는 곳은 GitHub(PR). 렌더·캐시는 파생본.
- **칸반 카드** = 그 프로젝트의 "지금 하는 큰 과제". TODO 항목 하나하나가 카드가 아니다. 연결은 카드 제목의 접두 `[<id>]` (`kanbanPrefix`) — 추가 필드 없이 지금 쓰는 관습 그대로.
- **상태 두 축**: TODO.md 의 `[~]/[ ]/[x]` 는 항목 상태(세밀), 칸반 lane 은 과제 상태(굵음). 탭은 둘을 나란히 보여 주고 합치지 않는다.
- **흐름**: 팀장 지시 → TODO.md 항목(정본) → 큰 과제면 칸반 카드 → 구현 → TODO `[x]` + 카드 done → 기능이 바뀌었으면 FEATURES 갱신(작업 근거는 TODO 에 남긴다). 정본은 `b3os-project-mgmt` 스킬.

## 1. 등록정보 — `projects.json` (저장소 루트, git 추적)

```json
[
  {
    "id": "steno",
    "name": "Steno",
    "repo": "b3rys/steno",
    "branch": "main",
    "docs": { "readme": "README.md", "design": "DESIGN.md", "features": "FEATURES.md", "todo": "TODO.md" },
    "kanbanPrefix": "[steno]",
    "excludeSections": ["킵", "선택 대기", "답 대기", "승인 대기"]
  }
]
```

- `docs` 키 4개는 고정(없는 파일은 화면에서 비활성). `kanbanPrefix` = 칸반 `task.title` 이 이걸로 시작하면 이 프로젝트의 과제.
- `excludeSections`(선택) = TODO.md 헤더 줄에 이 문자열 중 하나가 들어가면(부분 문자열 일치) 그 절의 `[ ]` 는 plan 에서 뺀다. 없으면 기본값 `["킵"]`. 이 목록이 정본이다 — 코드에 절 이름을 두지 않고, 서버가 API 응답에 실어 화면도 그것만 쓴다.

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
- private repo: 토큰은 서버 env `GITHUB_TOKEN` 만(로그·응답에 안 나감). 문서 응답도 `/team` 의 기존 열람 규칙을 따른다 — 토큰 숨기는 것만으로 문서 공개를 막지 못한다.
- 실패 동작: GitHub 401/404/네트워크 → 캐시가 있으면 캐시 + `stale: true`, 없으면 `{ error, key }` 502. 목록은 절대 빈 값으로 덮지 않는다(iCloud 교훈). `error` 는 브랜치 조회가 401/403/404 면 `github_auth_or_not_found`(토큰·저장소·브랜치 문제), 그 밖(네트워크·5xx)은 `github_unavailable`.

## 3. 렌더 (서버, 공통 렌더러 `src/server/lib/projectDocRender.ts`)

- Markdown → HTML: 기존 `skills/b3os-report/scripts/render.mjs` 를 옮겨 쓰지 말고 ★서버 모듈로 재작성★(zero-dep 유지: 헤딩·표·목록·인용·코드펜스·링크·이미지·체크박스·취소선).
- ```mermaid 블록 → 서버에서 SVG 로 변환해 인라인 (`@mermaid-js/mermaid-cli` 는 크롬 의존이라 ★쓰지 않는다★ — 우선 `beautiful-mermaid` 류 zero-dep 렌더러가 있으면 그것, 없으면 ★1차: `<pre class="mermaid-src">` 로 코드 그대로 + "다이어그램 렌더 예정" 배지★ 하고 `needs` 에 적는다. 보고서 iframe 의 실행 권한은 풀지 않는다).
- 상대 링크·이미지: `[x](docs/y.md)` → 같은 프로젝트 문서면 `?view=projects&id=steno&doc=…`, 아니면 GitHub blob URL.
- 원문 HTML 은 정제(script·on* 제거).
- TODO 파싱 규칙(`b3os-project-mgmt` TODO.md 모양): 줄 시작 `- [~]` doing · `- [ ]` plan · `- [x]` done. ★제외 절★(헤더 줄에 등록정보 `excludeSections` 의 문자열이 들어가는 절 — 기본 `킵`; steno 는 `킵`·`선택 대기`·`답 대기`·`승인 대기`)의 `[ ]` 는 plan 에서 뺀다 — 착수 예정으로 오인하지 않게. 하위 헤더까지 이어지고 형제 헤더에서 풀린다. `doingTitles` = `[~]` 줄의 첫 60자. "이번 주 완료" 는 안 센다(완료일 필드 없음).

## 4. 화면 (`src/web/components/Projects.ts`, Reports 와 같은 자리·같은 스타일)

- 탭: 상단 `global-reports-tab` 옆에 `global-projects-tab`. `/team?view=projects`. 별도 링크 `/projects` → 302 `/team?view=projects` (gate rewrite 한 줄 + 서버 redirect).
- 목록 줄: 이름 · intro · `GitHub` 링크 · 문서 4 칩(없으면 비활성) · `진행중 N · 계획 N · 완료 N` · 지금 과제(doingTitles 상위 3 + 칸반 doing 카드 제목) · fetchedAt.
- 문서 화면: 제목 · 좌측 toc · 본문 HTML · 우상단 `HTML | MD` 토글(같은 sha) · `GitHub 에서 보기` · sha 표시. TODO 는 "현재 상태" 탭(진행중·계획·완료 접힘)이 기본, "전체" 탭에 원문 HTML.
- 모바일: 목록은 카드, 문서는 toc 접힘.

## 5. 파일 소유권

| 담당 | 쓰는 파일 |
| --- | --- |
| 서버 | `projects.json` · `src/server/routes/projects.ts` · `src/server/lib/projectDocRender.ts` · `src/server/lib/projectTodo.ts` · `src/server/lib/githubDocs.ts` · 그 테스트 · `src/server/index.ts` 의 route 2줄(`api.route` + `/projects` redirect) |
| 화면 | `src/web/components/Projects.ts` · `MetricsBar.ts` 의 탭 버튼 · `main.ts` 의 view 등록(`VALID_MAIN_VIEWS`·렌더 분기) · `MobileTabBar.ts` · 스타일 |
| 게이트 | `~/Development/b3rys-gate/next.config.ts` rewrite 1줄 (`/projects` → 7878) — 오케스트레이터 |
| 검증 | `tests/` 아래 새 파일 · `docs/PROJECTS_TAB.md` §6 |

## 6. 수용 기준 (검증자가 잰다)

1. `GET /api/projects` 에 steno 1건, 4문서 exists, todo 건수가 TODO.md 를 직접 센 값과 같다, kanban 에 `[steno]` 카드.
2. DESIGN 문서 HTML 에 헤딩 toc 와 mermaid 6개가 (SVG 또는 코드+배지로) 모두 자리한다 — 빠진 것 0.
3. TODO "현재 상태" 에 킵 절 항목이 plan 으로 안 센다.
4. sha 갱신: 브랜치 sha 가 바뀌면 60초 안에 새 렌더, 그 전엔 캐시.
5. GitHub 실패 시 캐시 유지 + stale 표시, 목록 비지 않음.
6. `/projects` 직접 접속 → Projects 화면. 모바일 폭(390)에서 가로 스크롤 없음.
7. 기존 Reports 탭 회귀 0 (`bun test` 전체 + 기존 reports 테스트).
8. 토큰이 응답·로그에 안 나온다.

### §6 측정 결과 (검증자) · `a2c5a671`

격리 서버 `TEAM_HTTP_PORT=7899` + team.db 사본, 원본 md 는 `b3rys/steno` 를 replay(sha `6d2cce35`)·실조회(sha `c5b9a01`) 둘로 읽었다.

| # | 어떻게 쟀나 | 값 | 판정 |
| --- | --- | --- | --- |
| 1 | replay 로 `GET /team/api/projects` · TODO.md 를 별도 파서로 직접 셈 · team.db 사본 `select` | steno 1건 · 4문서 exists · todo 30/50/153 = 직접 센 값 · kanban 3건 = DB `[steno]` plan·doing 3건 | 통과 |
| 2 | DESIGN md 헤딩 수 vs `toc` · ```mermaid 수 vs `<figure class="project-diagram">` · 원문에 `<script>`·`onerror` 주입 후 렌더 | 헤딩 29=29 · mermaid 6=6(figure·mermaid-src·배지 각 6) · script 0 onerror 0 | 통과 |
| 3 | `/doc/todo` 의 `current.items` 를 section 별로 셈 | 킵·선택 대기·답 대기·승인 대기 절의 plan 0건 (제외 12건) | 통과 |
| 4 | `githubDocs.test.ts` TTL 케이스 + 뮤턴트(60_000→600_000) | 59,999ms 캐시·60,000ms 재조회 통과 · 뮤턴트 2 fail | 통과 |
| 5 | 토큰 dummy 로 띄워 실제 502 · 캐시 있는 상태로 재기동 → stale · 화면 사진 | 502 `{"error":"github_unavailable","key":"branch"}` · 재기동 후 200 `stale:true` 목록 1건 · 화면=오류 문구+다시 시도 / stale 배지 | 통과 |
| 6 | `curl -i /projects` · headless Chrome CDP 390 에뮬레이션 | 302 → `/team?view=projects` · 목록·DESIGN·TODO 세 화면 `scrollWidth` 390=390, 넘치는 요소 0 · toc 접힘 버튼 | 통과 |
| 7 | `bun run typecheck` · `bun test` 전체 · Reports 탭 사진 | tsc 0 · 3151 pass / 0 fail / 8 skip (254 파일, personaPathSafety 14/14) · Reports 80건 정상 | 통과 |
| 8 | `GITHUB_TOKEN=dummy-test-token` 으로 띄워 5개 경로 요청 뒤 로그·응답·캐시 파일 grep · `tests/projects/github-token.test.ts` | `dummy-test-token`/`ghp_`/`github_pat_`/`Authorization` 0건 · 헤더에는 실림(뮤턴트로 확인) | 통과 |

- 참고: 측정 당시 제외 절은 코드의 정규식이었고, `답 대기` 절(6건)이 §3 문구에 없었다(문구 기준 plan 56, 구현 50). 그 뒤 제외 절을 `projects.json` 의 `excludeSections` 로 옮겼다 — 위 값은 그 목록과 같은 네 절 기준이다.
- 뮤턴트 5종 모두 테스트 FAIL: TTL 600초(2) · 킵 제외 제거(3) · 정제 제거(1) · 화면 실패→빈 목록(4) · 토큰 헤더 제거(2).
