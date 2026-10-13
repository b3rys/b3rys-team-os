import { expect, test } from "bun:test";
import { nextVersion, publicNotes, type ReleasePR } from "./release-plan";
const pr = (title: string, number = 1): ReleasePR => ({ number, title, labels: [] });
test("feature PR bumps minor and resets patch", () => {
  expect(nextVersion("v0.6.1", [pr("fix: reconnect"), pr("feat(dashboard): version display", 2)])).toBe("0.7.0");
  expect(nextVersion("v0.6.1", [{ ...pr("New view"), labels: [{ name: "기능" }] }])).toBe("0.7.0");
});
test("fix/docs/chore-only bumps patch", () => {
  expect(nextVersion("v0.6.1", [pr("fix: reconnect"), pr("docs: setup", 2), pr("chore: dependencies", 3)])).toBe("0.6.2");
});
test("zero merged PRs is a no-op", () => { expect(nextVersion("v0.6.1", [])).toBeNull(); });
test("public notes remove scopes, names, paths and retrospective references", () => {
  const context = { agents: [{ display_name: "PrivateMember" }], projects: [{ name: "PrivateProject" }], ownerName: "PrivateOwner" };
  const notes = publicNotes("0.7.0", [pr("feat(secret-scope): dashboard version"), pr("fix: PrivateMember improved PrivateProject", 2), pr("docs: src/server/index.ts", 3), pr("chore: 회고 결과", 4)], context);
  expect(notes).toContain("dashboard version (#1)");
  for (const token of ["secret-scope", "PrivateMember", "PrivateProject", "src/server", "회고"]) expect(notes).not.toContain(token);
});
