import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { compactionPanel } from "./MonitoringView";
import { setLocale } from "../i18n";

afterEach(() => setLocale("ko"));

test("compaction table distinguishes zero, unmeasured and unknown token values, escaping ids", () => {
  setLocale("ko");
  const win = new Window();
  win.SyntaxError = SyntaxError;
  const root = win.document.createElement("div");
  const rows = [
    { memberId: "zero", count: 0, avgPreTokens: null, avgPostTokens: null, measured: true },
    { memberId: "hermes", count: 0, avgPreTokens: null, avgPostTokens: null, measured: false },
    { memberId: "<script>bad</script>", count: 2, avgPreTokens: 120000, avgPostTokens: null, measured: true },
  ];
  root.innerHTML = compactionPanel({ window24h: rows, window7d: rows });
  expect(root.querySelectorAll("table").length).toBe(2);
  const first = root.querySelector("table")!;
  const cells = first.querySelectorAll("tbody tr");
  expect(cells[0]!.querySelectorAll("td")[1]!.textContent).toBe("0");
  expect(cells[0]!.querySelectorAll("td")[2]!.textContent).toBe("—");
  expect(cells[1]!.textContent).toContain("미계측");
  expect(cells[2]!.textContent).toContain("120,000");
  expect(first.querySelector("script")).toBeNull();
});

test("English labels and empty windows", () => {
  setLocale("en");
  const html = compactionPanel({ window24h: [], window7d: [] });
  expect(html).toContain("Last 24h");
  expect(html).toContain("Last 7d");
  expect(html).toContain("No data");
});
