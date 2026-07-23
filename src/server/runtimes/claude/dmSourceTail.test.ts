/**
 * readTail 회귀 — 세션 jsonl 통째 읽기 대신 파일 끝 tail만 읽는다(GD 2026-07-09).
 * append-only라 최신 DM은 끝에 있고, tail 밖으로 밀려나기 전에 폴링이 이미 잡는다(dedup가 겹침 흡수).
 * 여기선 tail 경계 동작만 고정: 작은 파일=전체 / 큰 파일=끝부분만 + 잘린 첫 줄 폐기 + 끝 줄 온전.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTail } from "./dmSource";

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dmtail-"));
  const fp = join(dir, "session.jsonl");
  writeFileSync(fp, content, "utf8");
  return fp;
}

describe("readTail — tail-only 세션 읽기", () => {
  test("파일이 tailBytes보다 작으면 전체 반환(첫 줄 포함)", () => {
    const fp = tmpFile("first line\nsecond line\nthird line\n");
    const out = readTail(fp, 1024 * 1024);
    expect(out).toContain("first line");
    expect(out).toContain("third line");
  });

  test("파일이 tailBytes보다 크면 끝부분만 + 잘린 첫 줄 폐기", () => {
    const oldLine = "OLD_DM_BEYOND_TAIL " + "x".repeat(500);
    const filler = Array.from({ length: 200 }, (_, i) => `filler-${i} ` + "y".repeat(60)).join("\n");
    const newLine = "NEW_DM_AT_END unique-marker-42";
    const fp = tmpFile(`${oldLine}\n${filler}\n${newLine}\n`);

    const out = readTail(fp, 4096); // 4KB tail — oldLine은 창 밖
    expect(out).toContain("NEW_DM_AT_END"); // 끝 줄은 잡힘
    expect(out).toContain("unique-marker-42");
    expect(out).not.toContain("OLD_DM_BEYOND_TAIL"); // 창 밖 옛 줄은 안 읽음
    // 잘린 첫 줄 폐기 확인: 반환 텍스트의 첫 줄은 온전한(개행으로 시작된) 라인이어야 함
    const firstLine = out.split("\n")[0] ?? "";
    expect(firstLine.startsWith("filler-")).toBe(true); // 부분 잘린 라인 조각이 아님
  });

  test("tail 경계 안의 마지막 줄은 온전히 파싱 가능(JSON 라인 무결)", () => {
    const filler = Array.from({ length: 300 }, (_, i) => `{"n":${i},"pad":"${"z".repeat(40)}"}`).join("\n");
    const lastJson = `{"timestamp":"2026-07-09T06:00:00Z","marker":"tail-ok"}`;
    const fp = tmpFile(`${filler}\n${lastJson}\n`);
    const out = readTail(fp, 2048);
    const lines = out.split("\n").filter((l) => l.trim());
    const parsedLast = JSON.parse(lines.at(-1) ?? "{}");
    expect(parsedLast.marker).toBe("tail-ok"); // 끝 JSON 라인 온전 파싱
  });
});
