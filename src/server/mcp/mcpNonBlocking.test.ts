// ★본체를 멈추지 않는다★ 를 지키는 시험.
//
// 숫자(부하 측정)만으로는 안 보인다 — 부하가 가벼우면 동기 호출도 묻힌다(빌 지적).
// 그래서 ①구조로 ②동작으로 두 겹으로 잰다.
import { test, expect } from "bun:test";

// ── ① 구조: MCP 경로에 동기 호출이 남아 있으면 잡는다 ──
// 다시 들어오면 이 시험이 깨진다. 숫자는 안 드러나도 이건 드러난다.

// ★목록을 손으로 들지 않는다★ (리뷰 P1, bill) — 폴더를 읽는다.
// 손으로 들면 새 MCP 파일이 검사에서 빠지고, ★빠진 순간엔 아무 소리도 안 난다.★
// (#274 의 WRITE_TOOLS 와 같은 계열의 실수를 반복했다. 목록은 언젠가 갈라진다.)
async function mcpSourceFiles(): Promise<string[]> {
  const dir = new URL("./", import.meta.url).pathname;
  const names = [...new Bun.Glob("*.ts").scanSync(dir)];
  return names.filter((n) => !n.endsWith(".test.ts"));
}
// ★자식 프로세스 계열만 금지한다★ (리뷰, bill).
// 본질은 "동기" 가 아니라 ★끝을 모르는 일을 주 스레드에서 하는 것★ 이다.
// readFileSync 같은 건 작은 로컬 파일이면 마이크로초다 — 설정 한 줄 읽는 것까지 막으면 정당한 코드가 걸린다.
// ★오탐이 미탐보다 위험하다★: 정당한 변경을 막는 가드는 결국 사람이 지우고, 그때 spawnSync 금지까지 같이 사라진다.
const BLOCKING = ["spawnSync", "execSync", "execFileSync"];

test("★MCP 경로에 주 스레드를 붙드는 호출이 없다★ — 하나라도 들어오면 깨진다", async () => {
  const files = await mcpSourceFiles();
  expect(files.length).toBeGreaterThan(2); // 폴더를 못 읽어 빈 목록이면 '통과' 가 거짓이 된다
  const found: string[] = [];
  for (const f of files) {
    const src = await Bun.file(new URL(`./${f}`, import.meta.url)).text();
    for (const line of src.split("\n")) {
      if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue; // 주석은 뺀다
      for (const b of BLOCKING) if (line.includes(`${b}(`)) found.push(`${f}: ${b}`);
    }
  }
  expect(found).toEqual([]);
});

test("★대조군★ — 이 검사가 실제로 잡는다(일부러 만든 문자열을 센다)", () => {
  const fake = ["const x = Bun.spawnSync(['true']);", "  // spawnSync( 는 주석이라 안 세야 한다"];
  const hits = fake.filter((l) => !l.trimStart().startsWith("//") && l.includes("spawnSync("));
  expect(hits.length).toBe(1); // 코드 1건만, 주석은 제외
});

// ── ② 동작: 자식 프로세스를 기다리는 동안 이벤트 루프가 살아 있나 ──
// ★차이가 큰 입력으로 재야 보인다★ — 25ms 로는 노이즈에 묻힌다. 그래서 넉넉히 잡는다.

const SLEEP_MS = 600;

test("★비동기 spawn 은 기다리는 동안 다른 일이 돈다★", async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 50); // 기다리는 동안 계속 돌아야 한다
  const proc = Bun.spawn(["bash", "-c", `sleep ${SLEEP_MS / 1000}`], { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  clearInterval(timer);
  // 600ms 를 50ms 간격으로 → 이론상 ~11회. 여유 있게 5회만 넘으면 '루프가 살아 있었다' 로 본다.
  expect(ticks).toBeGreaterThan(5);
});

test("★대조군 — 동기 spawn 은 그 사이 아무것도 못 돈다★ (이 시험이 진짜 재는지 증명)", () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 50);
  Bun.spawnSync(["bash", "-c", `sleep ${SLEEP_MS / 1000}`]); // 일부러 동기
  clearInterval(timer);
  // 붙들려 있었으므로 타이머가 거의 못 돈다. 비동기(>5)와 명확히 갈린다.
  expect(ticks).toBeLessThan(3);
});
