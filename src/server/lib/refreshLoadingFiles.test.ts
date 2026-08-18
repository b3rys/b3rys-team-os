/**
 * ★두 방향을 같은 무게로 건다.★
 *   ① 있는 파일은 되맞춘다 — 이게 없으면 룰을 고쳐도 팀원에게 안 닿는다
 *   ② ★없는 파일은 만들지 않는다★ — 이게 없으면 게이트가 지키려던 '실멤버 보호' 가 깨진다
 * 한쪽만 재면 다음 사람이 반대쪽으로 고쳐도 초록이다.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshLoadingFiles } from "./refreshLoadingFiles";
import type { WriteMemberPersonaInput } from "./writeMemberPersona";

const ws = (): string => mkdtempSync(join(tmpdir(), "refresh-loading-"));

const member = (id: string, runtime: string, workspace: string): WriteMemberPersonaInput => ({
  id,
  display_name: id,
  role: "QA",
  runtime,
  workspace_path: workspace,
  persona_file: `${workspace}/SOUL.md`,
});

describe("refreshLoadingFiles", () => {
  test("★있는 로딩파일은 되맞춘다★ — 이게 없으면 룰을 고쳐도 팀원에게 안 닿는다", () => {
    const w = ws();
    writeFileSync(join(w, "AGENTS.md"), "옛 내용", "utf8");
    const calls: string[] = [];
    const r = refreshLoadingFiles([member("dex", "codex", w)], (m) => {
      calls.push(m.id);
      return { written: [join(w, "AGENTS.md")] };
    });
    expect(calls).toEqual(["dex"]);
    expect(r.updated).toEqual(["dex"]);
    expect(r.absent).toEqual([]);
  });

  test("★없는 로딩파일은 만들지 않는다★ — 게이트가 지키려던 실멤버 보호가 이것이다", () => {
    const w = ws(); // AGENTS.md 를 만들지 않는다
    const calls: string[] = [];
    const r = refreshLoadingFiles([member("newbie", "codex", w)], (m) => {
      calls.push(m.id);
      return { written: [] };
    });
    expect(calls, "★파일이 없는데 렌더러를 불렀다★").toEqual([]);
    expect(r.absent).toEqual(["newbie"]);
    expect(r.updated).toEqual([]);
    expect(existsSync(join(w, "AGENTS.md")), "★없던 파일이 생겼다★").toBe(false);
  });

  test("claude 런타임은 CLAUDE.md 를 본다 — 런타임마다 로딩파일이 다르다", () => {
    const w = ws();
    writeFileSync(join(w, "CLAUDE.md"), "옛 내용", "utf8");
    const r = refreshLoadingFiles([member("steve", "claude_channel", w)], () => ({ written: [join(w, "CLAUDE.md")] }));
    expect(r.updated).toEqual(["steve"]);

    // 대조군 — 같은 런타임인데 AGENTS.md 만 있으면 대상이 아니다
    const w2 = ws();
    writeFileSync(join(w2, "AGENTS.md"), "옛 내용", "utf8");
    const r2 = refreshLoadingFiles([member("steve2", "claude_channel", w2)], () => ({ written: ["x"] }));
    expect(r2.absent).toEqual(["steve2"]);
  });

  test("내용이 같으면 갱신했다고 말하지 않는다 — skip-if-unchanged 를 그대로 전한다", () => {
    const w = ws();
    writeFileSync(join(w, "AGENTS.md"), "같은 내용", "utf8");
    const r = refreshLoadingFiles([member("dex", "codex", w)], () => ({ written: [] }));
    expect(r.updated).toEqual([]);
    expect(r.absent).toEqual([]);
  });

  test("★렌더 대상이 아닌 런타임은 사유를 남긴다★ — 조용히 사라지면 왜 안 됐는지 아무도 모른다", () => {
    const w = ws();
    const r = refreshLoadingFiles([member("nat", "b3os_native", w)], () => ({ written: ["x"] }));
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.id).toBe("nat");
    expect(r.skipped[0]!.reason).toContain("b3os_native");
  });

  test("★한 명이 실패해도 나머지는 계속한다★ + 실패는 사유와 함께 남는다", () => {
    const w1 = ws();
    const w2 = ws();
    writeFileSync(join(w1, "AGENTS.md"), "옛 내용", "utf8");
    writeFileSync(join(w2, "AGENTS.md"), "옛 내용", "utf8");
    const r = refreshLoadingFiles(
      [member("bad", "codex", w1), member("good", "codex", w2)],
      (m) => {
        if (m.id === "bad") throw new Error("디스크가 가득 찼다");
        return { written: [join(w2, "AGENTS.md")] };
      },
    );
    expect(r.updated).toEqual(["good"]);
    expect(r.skipped).toEqual([{ id: "bad", reason: "디스크가 가득 찼다" }]);
  });
});
