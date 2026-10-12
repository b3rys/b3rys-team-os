/** Projects uses the Reports surfaces, text colours, and list spacing. */
export const projectsCss = `
.projects-list-head{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:10px;padding:12px 0;background:rgb(var(--surface-2) / .96);border-bottom:1px solid rgb(var(--border))}
.projects-refresh{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:1px solid rgb(var(--border));border-radius:6px;background:rgb(var(--surface-2));color:rgb(var(--slate-400));transition:background .15s,color .15s}
.projects-refresh:hover{background:rgb(var(--surface-0));color:rgb(var(--slate-100))}
.projects-refresh:focus-visible{outline:2px solid rgb(var(--accent));outline-offset:2px}
.projects-card{margin:18px 0;border:1px solid var(--border-strong);border-radius:12px;background:rgb(var(--surface-2));overflow:hidden;outline:none}
.projects-card-heading{margin:0;font:inherit}
.projects-card-head{display:block;width:100%;text-align:left;padding:18px 20px 14px;cursor:pointer;transition:background .15s}
.projects-card-head:hover:not(:disabled){background:rgb(var(--surface-0) / .65)}
.projects-card-head:focus-visible{outline:2px solid rgb(var(--slate-400));outline-offset:-3px}
.projects-card-head:disabled{cursor:default}
.projects-card-name{display:block;font-size:17px;font-weight:650;color:rgb(var(--slate-100));margin:0 0 5px}
.projects-card-intro{font-size:13px;line-height:1.6;color:rgb(var(--slate-400));display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.projects-track{padding:14px 20px;border-top:1px solid rgb(var(--border))}
.projects-track-line{display:flex;align-items:center;gap:14px;flex-wrap:wrap;min-width:0}
.projects-track-name{font-size:13px;font-weight:600;color:rgb(var(--slate-200));margin:0}
.projects-progress{width:64px;height:3px;border-radius:4px;background:rgb(var(--surface-0));overflow:hidden}
.projects-progress span{display:block;height:100%;background:rgb(var(--accent));border-radius:4px}
.projects-docs{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.projects-docs .projects-chip{height:24px;padding:0 6px;font-size:10px;border-radius:4px;border:0;background:rgb(var(--accent) / .06);color:var(--accent-soft-text);letter-spacing:.03em}
.projects-docs .projects-chip[data-disabled]{color:rgb(var(--slate-600));background:transparent}
.projects-github,.projects-updated{font-size:11px;color:rgb(var(--slate-500));white-space:nowrap}
.projects-updated{margin-left:auto}
.projects-now{display:grid;grid-template-columns:65px minmax(0,1fr);gap:10px;margin-top:12px;font-size:12px;color:rgb(var(--slate-500));line-height:1.7}
.projects-task{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:rgb(var(--slate-300));font-size:12px}
.projects-more summary{cursor:pointer;color:var(--accent-soft-text);font-size:11px;list-style:none;padding-top:3px;width:fit-content}
.projects-more summary::-webkit-details-marker{display:none}
.projects-more[open] summary{margin-bottom:4px}
.projects-doc-scroll{container-type:inline-size;container-name:project-document}
.projects-doc-shell{container-type:inline-size;container-name:project-document;max-width:none;margin:0 auto;padding:0 24px 80px;min-width:0}
.projects-doc-head{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:16px;padding:10px 0;min-height:60px;background:rgb(var(--surface-1) / .97);border-bottom:1px solid rgb(var(--border));backdrop-filter:blur(8px)}
.projects-back{display:inline-flex;align-items:center;gap:7px;min-height:36px;padding:0 11px;border:1px solid var(--border-strong);border-radius:6px;background:rgb(var(--surface-2));font-size:13px;font-weight:600;color:rgb(var(--slate-200));white-space:nowrap;flex-shrink:0}
.projects-back:hover{background:rgb(var(--surface-0));color:rgb(var(--slate-100))}
.projects-breadcrumb{min-width:0;font-size:13px;font-weight:600;color:rgb(var(--slate-200));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px}
.projects-breadcrumb span{color:rgb(var(--slate-500));font-weight:400}
.projects-doc-tabs{display:flex;align-self:stretch;align-items:stretch;gap:12px;min-width:0;overflow-x:auto;scrollbar-width:none}
.projects-doc-chip{display:inline-flex;align-items:center;min-height:36px;font-size:12px;font-weight:600;color:rgb(var(--slate-400));border-bottom:2px solid transparent;white-space:nowrap;letter-spacing:.02em}
.projects-doc-chip:hover{color:rgb(var(--slate-100))}
.projects-doc-chip.is-active{color:var(--accent-soft-text);border-bottom-color:rgb(var(--accent))}
.projects-doc-chip[aria-disabled]{opacity:.45}
.projects-tools{display:flex;align-items:center;gap:10px;margin-left:auto;flex-shrink:0}
.projects-modes{display:flex;gap:2px;background:rgb(var(--surface-0));padding:2px;border-radius:4px}
.projects-mode{min-height:32px;min-width:38px;font-size:12px;font-weight:600;color:rgb(var(--slate-400));padding:3px 7px;border-radius:3px}
.projects-mode.is-active{color:rgb(var(--slate-100));background:rgb(var(--surface-3))}
#projects-open-window,#projects-open-github{display:inline-flex;align-items:center;justify-content:center;min-width:32px;min-height:34px;color:rgb(var(--slate-300));border-radius:4px}
#projects-open-window:hover,#projects-open-github:hover{background:rgb(var(--surface-0))}
.projects-doc-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:24px;padding-top:24px;align-items:start;font-size:14.5px;max-width:76em;margin:0}
.projects-doc-layout.has-toc{grid-template-columns:210px minmax(0,1fr);max-width:calc(234px + 76em)}
.projects-toc-wrap{position:sticky;top:var(--projects-head,60px);align-self:start;min-width:0;max-height:calc(100vh / var(--dashboard-scale,1) - var(--projects-head,60px) - 24px);overflow-y:auto}
#projects-toc{padding:0 4px 8px;min-width:0}
#projects-toc.hidden{display:block}
.projects-toc-title{font-size:10px;font-weight:600;color:rgb(var(--slate-500));margin:0 0 9px 20px}
#projects-toc-toggle{display:none}
.projects-toc{font-size:12px;line-height:1.3}
.projects-toc-head{padding:3px 6px}
.projects-toc-children a{font-size:12px;padding:3px 6px}
.projects-reading{padding:26px 30px;border:1px solid rgb(var(--border));border-radius:10px;background:rgb(var(--surface-2));width:100%;max-width:100%;margin:0}
.projects-prose{line-height:1.7}
.projects-raw{font-size:12.5px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
.projects-prose ul,.projects-prose ol{padding-left:1.3em;margin:.6em 0}
.projects-prose ul{list-style-type:disc}
.projects-prose ol{list-style-type:decimal}
.projects-prose ul ul{list-style-type:circle}
.projects-prose ul.task-list{list-style:none;padding-left:.1em}
.projects-prose li{margin:.25em 0}
.projects-prose li>ul,.projects-prose li>ol{margin:.2em 0}
.projects-status-tabs{display:flex;gap:4px}
@container project-document (max-width:899px){
 .projects-doc-head{flex-wrap:wrap;gap:8px 12px;padding:8px 0}
 .projects-breadcrumb{flex:1;max-width:none}
 .projects-doc-tabs{order:4;flex-basis:100%;height:26px;gap:16px}
 .projects-doc-layout,.projects-doc-layout.has-toc{grid-template-columns:minmax(0,1fr);max-width:760px;margin:0 auto;gap:14px}
 .projects-toc-wrap{position:static;max-height:none;overflow:visible;border-bottom:1px solid rgb(var(--border));padding-bottom:10px}
 #projects-toc-toggle{display:block;font-size:12px;color:rgb(var(--slate-400));padding:0 0 2px}
 #projects-toc.hidden{display:none}
 #projects-toc{padding-top:10px;max-height:300px;overflow-y:auto}
 .projects-toc-title{display:none}
}
@container project-document (max-width:499px){
 .projects-doc-shell{padding:0 14px 50px}
 .projects-doc-head{gap:8px}
 .projects-breadcrumb{flex-basis:calc(100% - 60px);font-size:11px}
 .projects-tools{order:5;width:100%;justify-content:flex-end;margin-top:-1px}
 .projects-doc-tabs{gap:15px}
 .projects-doc-layout{padding-top:16px}
 .projects-reading{padding:20px 18px}
}
@media(max-width:600px){
 .projects-card-head{padding:16px}
 .projects-track{padding:12px 16px}
 .projects-track-line{gap:8px 12px}
 .projects-docs{flex-basis:100%;order:5}
 .projects-progress{width:45px}
 .projects-updated{margin-left:0}
 .projects-now{grid-template-columns:1fr;gap:2px}
}
`;
