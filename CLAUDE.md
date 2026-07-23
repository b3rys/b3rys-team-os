# team-collab — Project Rules

## 정체

이 폴더는 GD AI Team(6 agent) 협업 환경 + 웹 대시보드. 메타-인프라.

## 핵심 결정 (불변)

- **Stack**: Bun + Hono + bun:sqlite + Vite + Tailwind (CLAUDE.md 글로벌 룰의 "기존 의존성 재사용" 원칙)
- **포트**: 7878 (loopback only). 외부 노출은 CF Tunnel path `/team*`.
- **DB 위치**: `team.db` (프로젝트 루트, gitignore)
- **런타임 격리**: OpenClaw ↔ Claude Channel 직접 호출 금지. SQLite 만 경유.
- **prompt injection 방어**: 시스템 차원 `<external_message>` wrapper (skill/tool 내부)
- **OAuth rate limit**: SQLite `runtime_lock` 으로 Claude runtime 동시 호출 = 1

## 디렉토리 규칙

- `src/server/` — Hono 서버, worker, DB
- `src/web/` — Vite 프론트
- `src/shared/` — frontend/backend 공용 (envelope schema 등)
- `logs/` — audit 일일 rotation (gitignore)

## 작업 규칙

- 모든 milestone 10분 단위
- 새 worker / route 추가 시 SPEC 의 file_structure 와 일치 유지
- 시크릿(API 키, 토큰) 금지 — agents.json 에 메타데이터만
- 변경 시 TODO.md / MEMORY.md 즉시 갱신

## 참고

- SPEC: `../SPEC-team-collab.md`
- 리뷰 합성: `../reports/multi-ai-review-20260517-1340-team-collab-spec/synthesis.md`
