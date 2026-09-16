# Projects 탭 — 계약 (착수 기준)

팀장 지시(2026-09-16): 보고서와 동급의 Projects 탭. 프로젝트 목록에 주요 정보(GitHub · DESIGN · FEATURES · TODO · 지금 과제)를 보이고, 링크를 누르면 GitHub 의 md 를 보기 좋은 HTML 로(기본 HTML, MD 토글). 별도 링크로도 제공. 첫 대상 = steno.

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
    "kanbanPrefix": "[steno]"
  }
]
```

- `docs` 키 4개는 고정(없는 파일은 화면에서 비활성). `kanbanPrefix` = 칸반 `task.title` 이 이걸로 시작하면 이 프로젝트의 과제.

## 2. 서버 API (Hono, `/team` 아래 — 기존 rewrite 그대로)

| 메서드·경로 | 반환 | 비고 |
| --- | --- | --- |
| `GET /api/projects` | `{ projects: [ProjectSummary] }` | 목록 화면 한 번에 |
| `GET /api/projects/:id` | `ProjectSummary` | |
| `GET /api/projects/:id/doc/:key` | `{ id, key, sha, path, html, md, title, toc: [{level,text,anchor}] }` | `key ∈ readme·design·features·todo` |
| `GET /api/projects/:id/doc/:key/raw` | `text/markdown` | MD 토글 |
| `POST /api/projects/:id/refresh` | `{ sha }` | 캐시 무효화(수동) · `requireActor` |

```ts
type ProjectSummary = {
  id: string; name: string; repo: string; branch: string; sha: string;   // sha = 렌더 기준 commit
  intro: string;                       // README 첫 문단 (200자)
  docs: { key: "readme"|"design"|"features"|"todo"; path: string; exists: boolean }[];
  todo: { doing: number; plan: number; done: number; doingTitles: string[] };   // TODO.md 파싱
  kanban: { id: string; title: string; lane: "plan"|"doing"; updatedAt: string }[]; // team.db task, prefix 일치, done 제외
  fetchedAt: string;
};
```

- GitHub 원본: `https://raw.githubusercontent.com/<repo>/<sha>/<path>`. sha 는 `GET repos/<repo>/branches/<branch>` 를 ★60초★ TTL 로 재확인. 네 문서를 ★같은 sha★ 로 읽는다.
- 캐시 키 = `repo + sha + path + RENDERER_VERSION`. 저장은 `var/projects-cache/` (git 밖). 파생본이다 — 편집 원본이 아니다.
- private repo: 토큰은 서버 env `GITHUB_TOKEN` 만(로그·응답에 안 나감). 문서 응답도 `/team` 의 기존 열람 규칙을 따른다 — 토큰 숨기는 것만으로 문서 공개를 막지 못한다.
- 실패 동작: GitHub 401/404/네트워크 → 캐시가 있으면 캐시 + `stale: true`, 없으면 `{ error, key }` 502. 목록은 절대 빈 값으로 덮지 않는다(iCloud 교훈).

## 3. 렌더 (서버, 공통 렌더러 `src/server/lib/projectDocRender.ts`)

- Markdown → HTML: 기존 `skills/b3os-report/scripts/render.mjs` 를 옮겨 쓰지 말고 ★서버 모듈로 재작성★(zero-dep 유지: 헤딩·표·목록·인용·코드펜스·링크·이미지·체크박스·취소선).
- ```mermaid 블록 → 서버에서 SVG 로 변환해 인라인 (`@mermaid-js/mermaid-cli` 는 크롬 의존이라 ★쓰지 않는다★ — 우선 `beautiful-mermaid` 류 zero-dep 렌더러가 있으면 그것, 없으면 ★1차: `<pre class="mermaid-src">` 로 코드 그대로 + "다이어그램 렌더 예정" 배지★ 하고 `needs` 에 적는다. 보고서 iframe 의 실행 권한은 풀지 않는다).
- 상대 링크·이미지: `[x](docs/y.md)` → 같은 프로젝트 문서면 `?view=projects&id=steno&doc=…`, 아니면 GitHub blob URL.
- 원문 HTML 은 정제(script·on* 제거).
- TODO 파싱 규칙(`b3os-project-mgmt` TODO.md 모양): 줄 시작 `- [~]` doing · `- [ ]` plan · `- [x]` done. ★킵·승인대기★ 절(`📌 킵`, `GD 선택 대기`, `승인 대기` 헤더 아래)의 `[ ]` 는 plan 에서 뺀다. `doingTitles` = `[~]` 줄의 첫 60자. "이번 주 완료" 는 안 센다(완료일 필드 없음).

## 4. 화면 (`src/web/components/Projects.ts`, Reports 와 같은 자리·같은 스타일)

- 탭: 상단 `global-reports-tab` 옆에 `global-projects-tab`. `/team?view=projects`. 별도 링크 `/projects` → 302 `/team?view=projects` (gate rewrite 한 줄 + 서버 redirect).
- 목록 줄: 이름 · intro · `GitHub` 링크 · 문서 4 칩(없으면 비활성) · `진행중 N · 계획 N · 완료 N` · 지금 과제(doingTitles 상위 3 + 칸반 doing 카드 제목) · fetchedAt.
- 문서 화면: 제목 · 좌측 toc · 본문 HTML · 우상단 `HTML | MD` 토글(같은 sha) · `GitHub 에서 보기` · sha 표시. TODO 는 "현재 상태" 탭(진행중·계획·완료 접힘)이 기본, "전체" 탭에 원문 HTML.
- 모바일: 목록은 카드, 문서는 toc 접힘.

## 5. 파일 소유권

| 담당 | 쓰는 파일 |
| --- | --- |
| 서버(Devon) | `projects.json` · `src/server/routes/projects.ts` · `src/server/lib/projectDocRender.ts` · `src/server/lib/projectTodo.ts` · `src/server/lib/githubDocs.ts` · 그 테스트 · `src/server/index.ts` 의 route 2줄(`api.route` + `/projects` redirect) |
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
