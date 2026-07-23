import { beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderAgentSidebar } from "./AgentCard";
import { store, type Agent } from "../store";

function installDom(): Window {
  const win = new Window();
  const g = globalThis as Record<string, unknown>;
  g.window = win;
  g.document = win.document;
  g.localStorage = win.localStorage;
  g.HTMLElement = win.HTMLElement;
  g.PointerEvent = win.PointerEvent ?? win.MouseEvent;
  win.SyntaxError = SyntaxError;
  const proto = win.HTMLElement.prototype as unknown as {
    setPointerCapture?: (pointerId: number) => void;
    releasePointerCapture?: (pointerId: number) => void;
  };
  if (!proto.setPointerCapture) {
    proto.setPointerCapture = () => undefined;
    proto.releasePointerCapture = () => undefined;
  }
  return win;
}

function pointer(win: Window, type: string, init: Record<string, unknown> = {}): Event {
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(init)) {
    Object.defineProperty(event, key, { value });
  }
  return event as unknown as Event;
}

function agent(id: string, name: string): Agent {
  return {
    id,
    display_name: name,
    role: "Test member",
    runtime: "claude_channel",
    status_provider: "claude_tmux",
    tmux_session: null,
    telegram_bot_username: null,
    workspace_path: "/tmp",
    persona_file: "/tmp/AGENTS.md",
    moderator_eligible: true,
    avatar_emoji: "",
  };
}

describe("AgentCard drag reorder", () => {
  beforeEach(() => {
    installDom();
    localStorage.clear();
    store.getState().setAgents([agent("a", "A"), agent("b", "B"), agent("c", "C")]);
  });

  test("continues dragging after the pointer leaves the small handle", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    renderAgentSidebar(root);

    const handle = root.querySelector<HTMLElement>("[data-agent-drag-handle='a']");
    const target = root.querySelector<HTMLElement>("[data-agent-id='c']");
    expect(handle).toBeTruthy();
    expect(target).toBeTruthy();

    const originalElementFromPoint = document.elementFromPoint.bind(document);
    document.elementFromPoint = () => target;
    try {
      handle!.dispatchEvent(pointer(window as unknown as Window, "pointerdown", { button: 0, pointerId: 7, clientX: 1, clientY: 1 }));
      window.dispatchEvent(pointer(window as unknown as Window, "pointermove", { pointerId: 7, clientX: 80, clientY: 120 }));
      expect(Array.from(root.querySelectorAll<HTMLElement>("[data-agent-id]")).map((el) => el.dataset.agentId)).toEqual(["b", "c", "a"]);
      window.dispatchEvent(pointer(window as unknown as Window, "pointerup", { pointerId: 7, clientX: 80, clientY: 120 }));
    } finally {
      document.elementFromPoint = originalElementFromPoint;
    }

    expect(store.getState().agents.map((a) => a.id)).toEqual(["b", "c", "a"]);
    expect(JSON.parse(localStorage.getItem("bill-dash-agent-order") ?? "[]")).toEqual(["b", "c", "a"]);
  });

  test("stores the visible preview order when dragging upward", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    renderAgentSidebar(root);

    const handle = root.querySelector<HTMLElement>("[data-agent-drag-handle='c']");
    const target = root.querySelector<HTMLElement>("[data-agent-id='a']");
    expect(handle).toBeTruthy();
    expect(target).toBeTruthy();

    const originalElementFromPoint = document.elementFromPoint.bind(document);
    document.elementFromPoint = () => target;
    try {
      handle!.dispatchEvent(pointer(window as unknown as Window, "pointerdown", { button: 0, pointerId: 8, clientX: 1, clientY: 1 }));
      window.dispatchEvent(pointer(window as unknown as Window, "pointermove", { pointerId: 8, clientX: 80, clientY: 20 }));
      expect(Array.from(root.querySelectorAll<HTMLElement>("[data-agent-id]")).map((el) => el.dataset.agentId)).toEqual(["c", "a", "b"]);
      window.dispatchEvent(pointer(window as unknown as Window, "pointerup", { pointerId: 8, clientX: 80, clientY: 20 }));
    } finally {
      document.elementFromPoint = originalElementFromPoint;
    }

    expect(store.getState().agents.map((a) => a.id)).toEqual(["c", "a", "b"]);
    expect(JSON.parse(localStorage.getItem("bill-dash-agent-order") ?? "[]")).toEqual(["c", "a", "b"]);
  });

  test("shows short capacity label and danger dot when Claude uses credits", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    store.getState().setAgentHealth([
      {
        agentId: "a",
        level: "danger",
        livenessLevel: "ok",
        capacityLevel: "danger",
        capacityStatus: "usage_credits",
        capacityLabel: "크레딧 사용",
        reasons: ["Claude 크레딧 사용"],
        ctxPercent: 10,
        state: "running",
      },
    ]);
    renderAgentSidebar(root);

    expect(root.textContent).toContain("크레딧 사용");
    const dot = root.querySelector(".health-dot.danger");
    expect(dot).toBeTruthy();
  });
});
