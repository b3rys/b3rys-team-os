import { buildMatchers, lintDiff } from "../skills/b3os-release-ops/scripts/public-content-lint";

export type ReleasePR = { number: number; title: string; labels: { name: string }[]; mergeCommit?: { oid: string } | null };
export type PublicContext = Parameters<typeof buildMatchers>[0];
export function group(pr: ReleasePR): "Features" | "Fixes" | "Documentation" | "Maintenance" {
  const kinds = [pr.title.replace(/\(.+?\)/, ""), ...pr.labels.map(l => l.name)];
  if (kinds.some(k => /^(feat(?:ure)?s?|기능)(?:\b|[:：\s]|$)/i.test(k))) return "Features";
  if (kinds.some(k => /^(fix|bug|수정)(?:\b|[:：\s]|$)/i.test(k))) return "Fixes";
  if (kinds.some(k => /^(docs?|documentation|문서)(?:\b|[:：\s]|$)/i.test(k))) return "Documentation";
  return "Maintenance";
}
export function nextVersion(previous: string, prs: ReleasePR[]): string | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(previous);
  if (!m) throw new Error("Previous tag must be stable semver (vX.Y.Z)");
  if (!prs.length) return null;
  const [, major, minor, patch] = m;
  return prs.some(p => group(p) === "Features")
    ? `${major}.${Number(minor) + 1}.0` : `${major}.${minor}.${Number(patch) + 1}`;
}
export function publicNotes(version: string, prs: ReleasePR[], context: PublicContext): string {
  const matchers = buildMatchers({ ...context, agents: context.agents.flatMap(a => [a, { display_name: a.id }]) });
  const sections = ["Features", "Fixes", "Documentation", "Maintenance"] as const;
  const lines = [`# v${version}`, ""];
  for (const section of sections) {
    const items = prs.filter(p => group(p) === section);
    if (!items.length) continue;
    lines.push(`## ${section}`, "");
    for (const pr of items) {
      // Scope is an implementation identifier, not a user-facing description.
      let title = pr.title.replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, "").replace(/[\r\n\t]/g, " ");
      const diff = `--- a/notes.md\n+++ b/notes.md\n@@ -0,0 +1 @@\n+${title}`;
      const unsafe = lintDiff(diff, matchers).length || /[`\\/]|\b[\w-]+\.(?:md|json|sh|ts|py)\b|\b(?:SHARED|MEMORY|TEAM-OS)\b|회고|반성|팀장|내가|우리가|놓친|이었|하던|되던|않던|죽던|남던|사례|재측정|실측|리뷰.*(?:지적|피드백)|쓰던|놓치|talk notes|lead.as.source|adoption verdict|direct.?to.?gd|\bnever\b|op 방|승인.*우회|꺼진 권한|게이트 밖/i.test(title) || /\b[A-Z][A-Z_]{2,}\b/.test(title);
      if (unsafe) title = `${section === "Features" ? "Feature update" : section === "Fixes" ? "Reliability improvement" : section === "Documentation" ? "Documentation update" : "Maintenance update"}`;
      // Neutralize Markdown links/images/HTML from untrusted PR titles.
      title = title.replace(/[<>\[\]*_!#]/g, "");
      lines.push(`- ${title} (#${pr.number})`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function checkPublicNotes(notes: string, version: string, context: PublicContext): void {
  const matchers = buildMatchers({ ...context, agents: context.agents.flatMap(a => [a, { display_name: a.id }]) });
  const diff = `--- a/notes.md\n+++ b/notes.md\n@@ -0,0 +1 @@\n${notes.split("\n").map(l => "+" + l).join("\n")}`;
  if (!notes.startsWith(`# v${version}\n`) || lintDiff(diff, matchers).length || /[`\\]|\b[\w-]+\.(?:md|json|sh|ts|py)\b|\b[\w.-]+\/[\w.-]+|회고|반성|팀장|내가|우리가/.test(notes)) throw new Error("Notes require public-content review: version header, internal names, paths or retrospective content");
}
