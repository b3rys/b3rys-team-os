// ProjectsView — read-only task-prefix aggregates backed by /api/projects.

import { apiBase } from "../ws";
import { pick } from "../i18n";

type Lane = "done" | "doing" | "plan";

interface ProjectSummary {
  name: string;
  counts: Record<Lane, number>;
  next_action: string | null;
  owner: string | null;
}

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function progress(project: ProjectSummary): string {
  const total = project.counts.done + project.counts.doing + project.counts.plan;
  const width = (count: number) => total === 0 ? 0 : (count / total) * 100;
  return `
    <div class="min-w-[15rem]">
      <div class="flex h-2 overflow-hidden rounded-full bg-surface-0" aria-label="done ${project.counts.done}, doing ${project.counts.doing}, plan ${project.counts.plan}">
        <span class="bg-accent-green" style="width:${width(project.counts.done)}%"></span>
        <span class="bg-blue-400" style="width:${width(project.counts.doing)}%"></span>
        <span class="bg-slate-600" style="width:${width(project.counts.plan)}%"></span>
      </div>
      <div class="mt-1 text-[11px] text-slate-500">done ${project.counts.done} · doing ${project.counts.doing} · plan ${project.counts.plan}</div>
    </div>`;
}

function projectRow(project: ProjectSummary): string {
  return `
    <article data-project-row="${escape(project.name)}" class="grid grid-cols-1 gap-3 border-b border-surface-3 px-4 py-4 last:border-b-0 lg:grid-cols-[minmax(9rem,0.7fr)_minmax(15rem,1.2fr)_minmax(14rem,1.6fr)_minmax(7rem,0.5fr)] lg:items-center">
      <div class="font-semibold text-slate-100">${escape(project.name)}</div>
      ${progress(project)}
      <div class="min-w-0 text-sm text-slate-300"><span class="mr-2 text-xs text-slate-500">${pick("다음 액션", "Next action")}</span>${escape(project.next_action ?? "—")}</div>
      <div class="text-sm text-slate-300"><span class="mr-2 text-xs text-slate-500">${pick("담당자", "Owner")}</span>${escape(project.owner ?? "—")}</div>
    </article>`;
}

export function renderProjectsView(root: HTMLElement): void {
  let projects: ProjectSummary[] = [];
  let loaded = false;
  let failed = false;

  const render = () => {
    const body = !loaded
      ? `<div class="flex flex-1 items-center justify-center text-sm text-slate-500">${pick("프로젝트를 불러오는 중...", "Loading projects...")}</div>`
      : failed
        ? `<div class="flex flex-1 items-center justify-center text-sm text-status-blocked">${pick("프로젝트를 불러오지 못했습니다.", "Failed to load projects.")}</div>`
        : projects.length === 0
          ? `<div class="flex flex-1 items-center justify-center text-sm text-slate-500">${pick("승격된 프로젝트가 없습니다.", "No promoted projects.")}</div>`
          : `<div class="overflow-y-auto">${projects.map(projectRow).join("")}</div>`;
    root.innerHTML = `
      <div class="flex min-h-0 flex-1 flex-col">
        <div class="flex items-center justify-between border-b border-surface-3 bg-surface-1 px-4 py-2">
          <div class="text-sm font-semibold">Projects</div>
          <span class="text-[10px] text-slate-500">read-only</span>
        </div>
        ${body}
      </div>`;
  };

  const load = async () => {
    try {
      const response = await fetch(`${apiBase()}/api/projects`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { projects?: ProjectSummary[] };
      projects = body.projects ?? [];
      failed = false;
    } catch (error) {
      console.error("[loadProjects]", error);
      failed = true;
    }
    loaded = true;
    render();
  };

  render();
  void load();
}
