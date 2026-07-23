/**
 * Characterization tests for AgentSetup ④ split (2026-06-06) — locks in the rendered output of the
 * extracted ui-helpers / diagrams + the page assembler, and a DOM smoke for renderAgentSetup.
 * Static HTML (lowest risk): assert key markup is present rather than full-string snapshots.
 */
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Agent, DocSection, Status } from "../../store";
import {
  escape,
  section,
  policyCard,
  codeBlock,
  docHref,
  sourceLink,
  sourceLinks,
  rawSourceLink,
  miniNav,
  healthExampleCard,
} from "./ui-helpers";
import {
  teamMapDiagram,
  searchSystemDiagram,
  searchWorkflowDiagram,
  flowDiagram,
  communicationPrinciplesDiagram,
  manualSystemDiagram,
  organizationLoopDiagram,
  ownerResolutionDiagram,
} from "./diagrams";
import { page, renderAgentSetup } from "../AgentSetup";

// ─── ui-helpers ──────────────────────────────────────────────────────────────
describe("AgentSetup ui-helpers", () => {
  test("escape neutralizes HTML metacharacters", () => {
    expect(escape(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });
  test("section embeds escaped title + eyebrow + raw body", () => {
    const out = section("제목<b>", "EYE", "<div>body</div>");
    expect(out).toContain("제목&lt;b&gt;");
    expect(out).toContain("EYE");
    expect(out).toContain("<div>body</div>"); // body is raw (already-built HTML)
  });
  test("policyCard accent toggles emerald border", () => {
    expect(policyCard("t", "d", true)).toContain("border-emerald-500/35");
    expect(policyCard("t", "d", false)).not.toContain("border-emerald-500/35");
  });
  test("codeBlock escapes code content", () => {
    expect(codeBlock("a<b>c")).toContain("a&lt;b&gt;c");
  });
  test("sourceLink builds an href + escaped label", () => {
    const out = sourceLink("rules/TEAM-OS.md");
    expect(out).toContain('href="');
    expect(out).toContain("rules/TEAM-OS.md");
  });
  test("COMMUNICATION_FLOW source links open the dashboard viewer, with raw source separate", () => {
    expect(docHref("COMMUNICATION_FLOW.md")).toContain("?view=doc&doc=routing");
    expect(sourceLinks(["COMMUNICATION_FLOW.md"])).toContain("?view=doc&doc=routing");
    expect(rawSourceLink("COMMUNICATION_FLOW.md")).toContain("/docs/COMMUNICATION_FLOW.md");
  });
  test("miniNav marks the active section", () => {
    const out = miniNav("architecture");
    expect(out).toContain('data-doc-jump="architecture"');
    expect(out).toContain("border-accent-green/40"); // active styling present (var 토큰 — 차분한 테두리)
  });
  test("healthExampleCard renders badge + checks", () => {
    const out = healthExampleCard("T", "READY", "text-emerald-300", "meaning", ["c1", "c2"]);
    expect(out).toContain("READY");
    expect(out).toContain("· c1");
    expect(out).toContain("· c2");
  });
});

// ─── diagrams ────────────────────────────────────────────────────────────────
describe("AgentSetup diagrams", () => {
  test("each diagram returns non-empty markup with its hallmark", () => {
    expect(teamMapDiagram()).toContain("b3rys team map");
    expect(manualSystemDiagram()).toContain("b3os system architecture");
    expect(organizationLoopDiagram()).toContain("b3os organization operating loop");
    expect(ownerResolutionDiagram()).toContain("owner resolution order");
    expect(searchSystemDiagram()).toContain("team search system architecture");
    expect(searchWorkflowDiagram()).toContain("Reindex");
    expect(flowDiagram()).toContain("communication flow");
    expect(communicationPrinciplesDiagram()).toContain("communication principles timeline");
  });
});

// ─── page assembler ──────────────────────────────────────────────────────────
const agents: Agent[] = [
  { id: "bill", display_name: "Bill", role: "Infra", runtime: "claude_channel", tmux_session: "claude-bill", telegram_bot_username: "example_dev_bot", workspace_path: "/w", persona_file: "/p", avatar_emoji: "🤖" } as unknown as Agent,
];
const statuses = new Map<string, Status>();

describe("AgentSetup page()", () => {
  const sections: DocSection[] = ["policy", "architecture", "routing", "learning", "qa", "search"];
  test("every DocSection renders non-empty with the shared header", () => {
    for (const s of sections) {
      const out = page(s, agents, statuses);
      expect(out.length).toBeGreaterThan(200);
      expect(out).toContain("B3RYS TEAM OPERATING SYSTEM");
    }
  });
  test("routing section is the communication-flow dashboard viewer", () => {
    const out = page("routing", agents, statuses);
    expect(out).toContain("canonical viewer");
    expect(out).toContain("Owner 판정");
    expect(out).toContain("raw source");
    expect(out).toContain("READY");
    expect(out).not.toContain("COMMUNICATION_FLOW.md</a>");
  });
});

// ─── renderAgentSetup DOM smoke ──────────────────────────────────────────────
// SKIPPED: happy-dom is installed but @happy-dom/global-registrator is not, so a standalone
// Window's element.querySelector lacks a window context (SelectorParser throws). renderAgentSetup's
// output is already covered by page() snapshots above; the render wrapper only assigns innerHTML +
// wires buttons. Enable this once the DOM test harness (global-registrator) is added.
describe.skip("renderAgentSetup (DOM smoke)", () => {
  test("renders doc shell into root + wires doc-jump buttons", () => {
    const win = new Window();
    const g = globalThis as Record<string, unknown>;
    const prev = { window: g.window, document: g.document };
    g.window = win;
    g.document = win.document;
    try {
      const root = win.document.createElement("div");
      win.document.body.appendChild(root);
      renderAgentSetup(root as unknown as HTMLElement);
      expect(root.innerHTML).toContain("Team 운영 문서");
      expect(root.innerHTML).toContain("data-doc-scroll");
      expect(root.querySelectorAll("[data-doc-jump]").length).toBeGreaterThan(0);
    } finally {
      g.window = prev.window;
      g.document = prev.document;
    }
  });
});
