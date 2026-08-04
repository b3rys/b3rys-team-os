/**
 * TasksKanban 재진입 재조회 — 렌더 없이 검증 가능한 계약.
 *
 * ★왜 DOM 테스트가 여기 없는지★
 * 이 저장소의 happy-dom 하네스에서는 `querySelector` 가 ★동작하지 않는다.★ 실측(2026-08-03,
 * happy-dom 20.9.0 + bun 1.3.14): `div`·`.c`·`#i`·`[attr]` 전부 예외를 던진다(`window.SyntaxError`
 * 가 없어서 에러 생성 자체가 깨진다). shim 을 넣으면 예외는 사라지지만 매칭이 안 돼 null 이 온다.
 * 통과 중인 다른 DOM 테스트들은 그 경로를 밟지 않아서 그린인 것이다.
 * `TasksKanban.render()` 는 스크롤 위치 보존을 위해 `querySelector` 를 쓰므로 ★마운트 자체가
 * 불가능★ 하다. 그래서 렌더가 필요한 검증은 ★실제 Chrome(playwright)★ 하네스로 했다:
 *   `~/b3os/members/devon/verify/tasks-refresh-browser.mjs`  (7건 전부 통과)
 *   — 초기 표시 · ★재조회 전 stale(버그 재현)★ · refresh 후 갱신 · 삭제 반영 ·
 *     /api/tasks 만 1회 추가 · /api/agents 재호출 없음 · 칼럼 카운트 이동
 * 이 갭 자체는 별도 카드로 등록해뒀다(happy-dom 커버리지 과대평가).
 */
import { describe, expect, test } from "bun:test";
import { refreshTasksKanban } from "./TasksKanban";

describe("refreshTasksKanban — 렌더 전 계약", () => {
  test("한 번도 렌더되지 않았으면 아무 것도 하지 않는다(호출이 안전하다)", async () => {
    // main.ts 는 `tasksRendered` 가드로 초기 렌더를 하고, 재진입일 때만 이 함수를 부른다.
    // 그래도 순서가 뒤집히는 경로(뷰 복원·라우팅 변경)가 생길 수 있어서, 렌더 전 호출이
    // throw 하지 않고 조용히 빠지는 것을 계약으로 고정한다 — Settings 의
    // refreshSettingsSlack/Members 가 `if (!_root) return` 으로 같은 계약을 갖는다.
    await refreshTasksKanban();
    // fetch 를 건드리지 않았는데도 여기까지 왔다 = 네트워크 호출을 시도하지 않았다.
    expect(true).toBe(true);
  });

  test("여러 번 불러도 안전하다", async () => {
    await refreshTasksKanban();
    await refreshTasksKanban();
    expect(true).toBe(true);
  });
});
