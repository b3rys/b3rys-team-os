import { afterEach, expect, test } from "bun:test";
import { setLocale } from "../../i18n";
import { page } from "../AgentSetup";
import { miniNav } from "./ui-helpers";

afterEach(() => setLocale("ko"));

for (const locale of ["ko", "en"] as const) {
  test(`workflow content and navigation (${locale})`, () => {
    setLocale(locale);
    const html = page("workflow");
    expect(html.match(/<table /g)?.length).toBe(2);
    expect(html.match(/<tr class=/g)?.length).toBe(8);
    const diagram = html.split("<figure")[1]!.split("</figure>")[0];
    for (const label of ["SF", "BWF", "FPFC", "Find", "Pick", "Fix", "Check", "①", "②", "③", "④", "⑤", "⑥"]) {
      expect(diagram).toContain(label);
    }
    expect(html).toContain(locale === "ko" ? "순서가 아니라 역할 이름" : "role names, not an order");
    expect(html).toContain(locale === "ko" ? "런타임이 agent 마다 모델을 정할 수 없으면" : "If the runtime cannot set a model per agent");
    expect(html).toContain('model-selection.md');
    expect(miniNav("workflow")).toContain(locale === "ko" ? "작업 플로우" : "Workflow");

  });
}
