/**
 * 태그 UI — ★알약은 필터, 편집은 팝업★ (팀장님 지시 2026-07-30)
 *
 * ■ 이 파일이 왜 다시 쓰였나
 * 앞선 두 판은 태그 옆 hover 아이콘을 시험했고, ★두 판 다 통과한 상태로 실제로는 못 쓰는 물건이었다.★
 *   1차 — "줄이 흔들리지 않는다" 를 통과. 흔들리지 않은 이유가 ★빈칸을 미리 비워둬서★ 였다.
 *   2차 — "자리를 차지하지 않는다(absolute)" 를 통과. 그런데 알약과 아이콘 사이 4px 틈에서
 *          hover 가 풀려 ★손이 닿기 전에 사라졌다.★
 * 마크업 시험은 "무엇이 있나" 는 재도 "사람이 닿을 수 있나" 는 못 잰다. 그래서 UI 를 바꿨고,
 * 시험도 ★조작이 hover 에 걸려 있지 않다★ 는 것을 직접 단정하도록 바꾼다.
 */
import { describe, expect, test } from "bun:test";
import { collectTagEdit, tagEditBodyHtml, tagPillsHtml } from "./Reports";

const pillCls = (active: boolean) => (active ? "ACTIVE" : "IDLE");
const tag = (id: string, name: string, count = 0) => ({ id, name, color: "blue", report_count: count });

describe("tagPillsHtml — 알약은 필터 하나만 한다", () => {
  test("★조작이 hover 에 걸려 있지 않다★ — 이게 두 번 무너진 지점이다", () => {
    const html = tagPillsHtml([tag("t1", "주간보고", 3), tag("t2", "인프라")], new Set(), pillCls);
    // hover 로만 나타나는 요소가 있으면 "보이는데 못 누르는" 상태가 다시 생길 수 있다.
    expect(html, "hover 로만 보이는 조작이 남아 있으면 안 된다").not.toContain("group-hover");
    expect(html).not.toContain("opacity-0");
    // 알약 밖으로 띄우는 배치(4px 틈이 생기던 그 배치)도 없어야 한다.
    expect(html).not.toContain("left-full");
    expect(html).not.toContain("absolute");
  });

  test("이름 바꾸기·지우기 버튼은 알약 옆에 없다 (팝업으로 갔다)", () => {
    const html = tagPillsHtml([tag("t1", "주간보고")], new Set(), pillCls);
    expect(html).not.toContain("reports-tag-edit");
    expect(html).not.toContain("reports-tag-del");
    expect((html.match(/reports-tag-pill/g) ?? []).length).toBe(1);
  });

  test("★태그 이름이 속성을 깨지 않는다★ — 이름은 사용자 입력이다", () => {
    const html = tagPillsHtml([tag("t1", '따옴표" <b>태그</b>')], new Set(), pillCls);
    expect(html).not.toContain('data-tag-name="따옴표" <b>');
    expect(html).toContain("&quot;");
    expect(html).toContain("&lt;b&gt;");
  });

  test("선택된 태그는 pillCls(true) 를 받는다 (필터 표시 유지)", () => {
    // ★알약 단위로 잘라서 본다★ — 앞선 판에서는 "id 위치에서 200자 앞" 으로 잘랐는데, 마크업이
    //   짧아지자 그 값이 음수가 돼 slice 가 ★문자열 끝에서★ 잘랐다(시험이 엉뚱한 곳을 봤다).
    const pills = tagPillsHtml([tag("t1", "a"), tag("t2", "b")], new Set(["t2"]), pillCls)
      .split("</button>").filter(Boolean);
    expect(pills.length).toBe(2);
    expect(pills.find((p) => p.includes('data-tag-id="t1"'))).toContain("IDLE");
    expect(pills.find((p) => p.includes('data-tag-id="t2"'))).toContain("ACTIVE");
  });

  test("보고서 수를 보여준다 (없으면 0)", () => {
    expect(tagPillsHtml([tag("t1", "a", 7)], new Set(), pillCls)).toContain(">7<");
    expect(tagPillsHtml([{ id: "t2", name: "b", color: "blue" }], new Set(), pillCls)).toContain(">0<");
  });

  test("태그가 없으면 빈 문자열 (호출부가 '등록된 태그 없음' 을 띄운다)", () => {
    expect(tagPillsHtml([], new Set(), pillCls)).toBe("");
  });
});

describe("tagEditBodyHtml — 팝업이 고를 것을 다 보여준다", () => {
  test("있는 태그를 전부 보여준다 — ★외워서 적게 하지 않는다★", () => {
    const html = tagEditBodyHtml([tag("t1", "주간보고"), tag("t2", "인프라")]);
    expect(html).toContain("#주간보고");
    expect(html).toContain("#인프라");
    expect((html.match(/data-tag-target/g) ?? []).length).toBe(2);
  });

  test("★첫 태그가 미리 골라져 있다★ — 아무것도 안 고른 채 확인을 눌러 허탕치지 않게", () => {
    const html = tagEditBodyHtml([tag("t1", "주간보고"), tag("t2", "인프라")]);
    expect((html.match(/ checked/g) ?? []).length).toBe(2); // 태그 1 + 동작(이름 바꾸기) 1
    expect(html.slice(0, html.indexOf("t2"))).toContain("checked");
  });

  test("동작은 이름 바꾸기·지우기 두 개고 ★이름 바꾸기가 기본★ (실수로 지우지 않게)", () => {
    const html = tagEditBodyHtml([tag("t1", "a")]);
    expect(html).toContain('value="rename"');
    expect(html).toContain('value="delete"');
    const renameIdx = html.indexOf('value="rename"');
    expect(html.slice(renameIdx, renameIdx + 60)).toContain("checked");
    expect(html.slice(html.indexOf('value="delete"'), html.indexOf('value="delete"') + 60)).not.toContain("checked");
  });

  test("태그가 하나도 없어도 새로 만들 칸은 있다", () => {
    const html = tagEditBodyHtml([]);
    expect(html).toContain("아직 만들어진 태그가 없습니다");
    expect(html).toContain("data-tag-new");
    expect(html).not.toContain("data-tag-target");
  });

  test("★태그 이름이 속성을 깨지 않는다★", () => {
    const html = tagEditBodyHtml([tag("t1", '따옴표" <b>')]);
    expect(html).not.toContain('data-tag-name="따옴표" <b>');
    expect(html).toContain("&quot;");
  });
});

describe("collectTagEdit — 팝업에서 고른 것을 읽어낸다", () => {
  /** happy-dom 없이 필요한 부분만 흉내낸다 — querySelector 만 쓰므로 충분하다. */
  const rootWith = (fields: { target?: { value: string; name: string }; action?: string; newName?: string }) =>
    ({
      querySelector: (sel: string) => {
        if (sel.includes("data-tag-target")) {
          return fields.target ? { value: fields.target.value, dataset: { tagName: fields.target.name } } : null;
        }
        if (sel.includes("data-tag-action")) return fields.action ? { value: fields.action } : null;
        if (sel.includes("data-tag-new")) return { value: fields.newName ?? "" };
        return null;
      },
    }) as unknown as HTMLElement;

  test("고른 태그와 동작을 그대로 돌려준다", () => {
    const got = collectTagEdit(rootWith({ target: { value: "t1", name: "주간보고" }, action: "delete" }));
    expect(got).toEqual({ tagId: "t1", tagName: "주간보고", action: "delete", newName: "" });
  });

  test("새 이름은 ★앞뒤 공백을 떼서★ 돌려준다 (' 주간 ' 이 새 태그가 되지 않게)", () => {
    const got = collectTagEdit(rootWith({ target: { value: "t1", name: "a" }, action: "rename", newName: "  새태그  " }));
    expect(got.newName).toBe("새태그");
  });

  test("아무것도 안 고른 상태는 빈 값 — 호출부가 아무 일도 하지 않는 근거가 된다", () => {
    expect(collectTagEdit(rootWith({}))).toEqual({ tagId: "", tagName: "", action: "", newName: "" });
  });
});
