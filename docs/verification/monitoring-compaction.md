# 멤버별 압축 계측

| 기능 / 접근 | 소스 | 자동 검사 | 화면 검사 | 경계 오류 주입 | 미검증 |
|---|---|---|---|---|---|
| Monitoring → 멤버별 홉 옆 멤버별 압축. 24h/7d 횟수·평균 전후 토큰, 0회와 미계측 구분 | `src/server/lib/compactionMetrics.ts`, `src/server/lib/monitoringStatus.ts`, `src/server/routes/monitoring.ts`, `src/web/components/MonitoringView.ts` | `monitoringStatus.compactionMetrics.test.ts`, `MonitoringView.compaction.test.ts` | DOM 표의 0회·미계측·누락 토큰·ID 이스케이프·한국어/영어 검사 | 기간 시작 경계를 `>=`에서 `>`로 바꾸면 2개 시험 실패, 원본 복원 확인 | 라이브 세션 데이터·실제 브라우저 배치·운영 부하. 머지·배포 후 별도 확인 |
| 평균 전후 토큰 정수 표시 (24h/7d) | `src/web/components/MonitoringView.ts` | `MonitoringView.compaction.test.ts`: 833397.75 → 833,398, 243791.833 → 243,792; 서버 원값 유지 | 두 표의 DOM 토큰 셀 검사 | 정수 포맷 제거 시 1개 시험 실패, 원본 복원 확인 | 실제 브라우저·배포 후 확인 |

## 집계 기준

- 기간은 이벤트 timestamp 기준 `[현재 - 기간, 현재]`이며 미래 기록은 제외한다.
- JSONL 파일은 최근 7일 mtime만 읽는다. 날짜 디렉터리가 오래됐더라도 파일이 최근 수정됐으면 읽는다.
- 읽기는 스트림으로 진행하며 표지 문자열이 없는 줄은 JSON.parse하지 않는다.
- 파일별 size·mtime 캐시와 독립 5분 결과 캐시를 쓴다. 동시 요청은 진행 중 집계를 공유한다.
- Claude 프로젝트 경로는 workspace_path에서 만든다. `~/`는 주입한 homeDir로 확장한다.
- OpenClaw는 openclaw_agent_id, Codex는 멤버 id로 세션 루트를 만든다.
- 지원 런타임의 세션 파일 부재는 0회로 표시한다. 지원하지 않는 런타임·읽기 실패는 미계측으로 표시한다.
- 누락·음수·숫자가 아닌 토큰 값은 평균에서 제외하며, 유효 값이 없으면 null이다. Codex 직후 토큰은 null이다.
- 레지스트리에서는 id·runtime·workspace_path·openclaw_agent_id만 접근한다. 세션 원문이나 자격 증명을 응답·로그에 출력하지 않는다.

## 검증 명령

```sh
bun test src/server/lib/monitoringStatus.compactionMetrics.test.ts src/server/lib/monitoringStatus.dmHealth.test.ts src/server/lib/monitoringStatus.livenessStatus.test.ts src/web/components/MonitoringView.compaction.test.ts
bun run typecheck
bun run build
```

되돌리기: 해당 기능 커밋을 revert한다. DB·레지스트리·원본 세션 로그는 수정하지 않는다.
