/** Run this function with a Playwright page against Vite on port 5190.
 * All API/WebSocket data are generic; mutation and live API requests are blocked.
 * Screenshots are written to artifacts/display-scale-followup relative to the browser working directory.
 */
async (page) => {
  const origin = 'http://127.0.0.1:5190';
  const assets = 'artifacts/display-scale-followup';
  const agents = ['a', 'b', 'c'].map(id => ({ id, display_name: `Sample ${id.toUpperCase()}`, role: 'Example member', runtime: 'codex', status_provider: 'codex_cli', tmux_session: null, telegram_bot_username: null, workspace_path: '/tmp/sample', persona_file: '', moderator_eligible: false, avatar_emoji: '', icon: 'code' }));
  const statuses = agents.map(a => ({ agent_id: a.id, state: 'running', last_activity_at: null, last_log_line: null, tmux_pid: null, ctx_percent: 25, probed_at: '2026-10-12T06:00:00Z' }));
  const report = { id: 'sample-report', title: 'Sample report', author: 'sample', summary: 'Example report preview', category: 'Report', forms: ['html'], created_at: '2026-10-12T06:00:00Z' };
  const proposal = { id: 'sample-proposal', title: 'Sample proposal', summary: 'Example review', proposer_agent: 'a', status: 'accepted', created_at: '2026-10-12 06:00:00', updated_at: '2026-10-12 06:00:00' };
  await page.unroute('**/team/api/**');
  await page.unroute('**/reports/**');
  await page.addInitScript(({ agents, statuses }) => {
    localStorage.clear(); localStorage.setItem('b3os-dashboard-scale', '150');
    window.WebSocket = class {
      static OPEN = 1; readyState = 1;
      constructor() { setTimeout(() => { this.onopen?.({}); this.onmessage?.({ data: JSON.stringify({ type: 'hello', agents, statuses }) }); }, 100); }
      send() {} close() { this.readyState = 3; }
    };
  }, { agents, statuses });
  await page.route('**/team/api/**', route => {
    if (route.request().method() !== 'GET') return route.abort();
    const path = route.request().url().split('/team/api')[1].split('?')[0];
    let json = {};
    if (path === '/settings') json = { team_name: 'Sample team', setup_complete: true };
    else if (path === '/agents') json = { agents, statuses };
    else if (path === '/threads') json = { threads: [{ id: 'sample-thread', title: 'Example thread', kind: 'dm', participants: ['a'], status: 'open', last_message_at: '2026-10-12T06:00:00Z' }] };
    else if (path === '/tasks') json = { tasks: [] };
    else if (path === '/metrics') json = { metrics: [] };
    else if (path === '/alerts') json = { alerts: [] };
    else if (path === '/members') json = agents;
    else if (path === '/bus/members') json = { members: [] };
    else if (path === '/proposals') json = { proposals: [proposal] };
    else if (path.startsWith('/proposals/')) json = { proposal, reviews: [], decision_log: [] };
    return route.fulfill({ json });
  });
  await page.route('**/reports/**', route => {
    if (route.request().method() !== 'GET') return route.abort();
    if (route.request().url().includes('/file/')) return route.fulfill({ contentType: 'text/html', body: '<html><body><h1>Sample report</h1><p>Example preview at 150%.</p></body></html>' });
    return route.fulfill({ json: route.request().url().includes('/api/list') ? { reports: [report], total: 1, total_all: 1, has_more: false, tags: [], category_counts: { Report: 1 } } : report });
  });
  const checks = [];
  function verify(ok, name, values) { checks.push({ name, ok, values }); if (!ok) throw new Error(JSON.stringify(checks)); }
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.goto(`${origin}/team/?view=topology`);
  await page.waitForSelector('#main-content svg[viewBox="0 0 660 540"]');
  await page.evaluate(async () => { const panels = await import("/team/lib/panels.ts"); panels.PANEL_IDS.forEach(id => panels.applyPanelCollapsed(id, true)); });
  const topology = await page.locator('#main-content svg[viewBox="0 0 660 540"]').evaluate(svg => ({ height: svg.getBoundingClientRect().height, max: parseFloat(getComputedStyle(svg).maxHeight) * 1.5 }));
  verify(topology.height <= 641 && Math.abs(topology.max - 640) < 2, 'Topology 64vh remains 640 viewport pixels at 150%', topology);
  await page.screenshot({ path: `${assets}/topology-150pct.png` });

  await page.goto(`${origin}/team/?view=reports`);
  await page.waitForSelector('.reports-card');
  await page.evaluate(async () => { const panels = await import("/team/lib/panels.ts"); panels.PANEL_IDS.forEach(id => panels.applyPanelCollapsed(id, true)); });
  await page.locator('.reports-card').click();
  await page.waitForSelector('#reports-viewer iframe');
  const frame = await page.locator('#reports-viewer iframe').evaluate(el => ({ height: el.getBoundingClientRect().height, min: parseFloat(getComputedStyle(el).minHeight) * 1.5 }));
  verify(Math.abs(frame.height - 700) < 2 && Math.abs(frame.min - 700) < 2, 'Reports 70vh remains 700 viewport pixels at 150%', frame);
  await page.screenshot({ path: `${assets}/reports-150pct.png` });

  await page.goto(`${origin}/team/?view=proposals`);
  await page.waitForSelector('[data-proposal-id="sample-proposal"]');
  await page.evaluate(async () => { const panels = await import("/team/lib/panels.ts"); panels.PANEL_IDS.forEach(id => panels.applyPanelCollapsed(id, true)); });
  await page.locator('[data-archive-proposal="sample-proposal"]').click();
  await page.waitForSelector('[data-proposal-action-form]');
  const form = await page.locator('[data-proposal-action-form]').evaluate(el => {
    const content = document.createElement('div');
    content.innerHTML = '<p style="margin:1rem 0">Example review content with enough lines to exercise the scroll limit.</p>'.repeat(35);
    el.prepend(content);
    const rect = el.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: rect.height, scrollable: el.scrollHeight > el.clientHeight };
  });
  verify(form.top >= 0 && form.bottom <= 1001 && form.scrollable, 'Proposal form scrolls within the viewport at 150%', form);
  await page.screenshot({ path: `${assets}/proposal-150pct.png` });
  await page.keyboard.press('Escape');

  await page.goto(`${origin}/team/?view=tasks`);
  await page.waitForSelector('[data-agent-drag-handle="a"]');
  const cardA = page.locator('[data-agent-id="a"]');
  const cardC = page.locator('[data-agent-id="c"]');
  const before = await cardA.boundingBox();
  await page.evaluate(() => { window.__reorderFrames = []; const saved = Element.prototype.animate; Element.prototype.animate = function (frames, options) { window.__reorderFrames.push({ id: this.dataset.agentId, frames }); return saved.call(this, frames, options); }; });
  const handle = await page.locator('[data-agent-drag-handle="a"]').boundingBox();
  const target = await cardC.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down(); await page.mouse.move(target.x + 70, target.y + target.height / 2);
  const animation = await page.evaluate(() => window.__reorderFrames.find(x => x.id === 'a'));
  await page.evaluate(() => document.querySelectorAll("[data-agent-id]").forEach(el => el.getAnimations().forEach(animation => animation.cancel())));
  const after = await cardA.boundingBox();
  const delta = before.y - after.y;
  const displacement = parseFloat(animation.frames[0].transform.match(/translateY\(([-\d.]+)px\)/)[1]);
  verify(Math.abs(displacement * 1.5 - delta) < 2, 'AgentCard animation starts at its prior viewport position at 150%', { delta, displacement });
  await page.mouse.up(); await page.waitForTimeout(160);
  await page.screenshot({ path: `${assets}/agent-reorder-150pct.png` });
  return checks;
}
