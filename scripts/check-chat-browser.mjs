import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';

const capture = process.argv.includes('--capture');
const output = resolve('docs/design/chat/comparison');
let web, exited, origin = process.env['CHAT_BASE_URL'];
if (!origin) {
  let logs = '';
  web = spawn(process.execPath, ['--experimental-strip-types', '--import', resolve('apps/server/test/support/ephemeral-ports.ts'), resolve('node_modules/@angular/cli/bin/ng.js'), 'serve', '--prebundle=false', '--live-reload=false', '--hmr=false', '--host', '127.0.0.1', '--port', '0'],
    { cwd: resolve('apps/web'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
  exited = once(web, 'exit');
  web.stdout.on('data', chunk => { logs += chunk.toString(); }); web.stderr.on('data', chunk => { logs += chunk.toString(); });
  const deadline = Date.now() + 90_000;
  while (!origin) {
    origin = /Local:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(logs)?.[1];
    if (web.exitCode !== null || Date.now() > deadline) { web.kill(); throw new Error(`Angular did not start: ${logs}`); }
    await delay(100);
  }
}
const browser = await chromium.launch();
const stable = async page => {
  await page.locator('oc-workspace').waitFor();
  await page.waitForFunction(() => !globalThis.document.querySelector('.skeleton'));
  await page.evaluate(() => globalThis.document.fonts.ready);
  // Wait for a zoneless render, rather than treating the HTTP response as a painted view.
  await page.evaluate(() => new Promise(resolve => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))));
};

function agentBadgeStyle(node) {
  const style = globalThis.getComputedStyle(node);
  return { background: style.backgroundColor, fontFamily: style.fontFamily };
}

async function open(scenario, width = 390) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: 'reduce' });
  if (scenario === 'rail-offline') await page.clock.install();
  const fixture = await chatFixture(page, scenario);
  await page.goto(`${origin}/workspace${['draft', 'attach', 'no-agent', 'queued', 'rail-offline', 'rail-loading'].includes(scenario) ? '' : '?conversation=chat'}`);
  if (scenario === 'rail-loading') { await page.locator('.rail-card').waitFor({ state: 'attached' }); await page.evaluate(() => globalThis.document.fonts.ready); }
  else await stable(page); return { page, fixture };
}
try {
  // A conversation's desktop entry is keyboard reachable in both session panels.
  for (const width of [1280, 390]) {
    const { page } = await open('live', width);
    await page.route('**/api/conversations/chat/view', route => route.fulfill({ status: 403, contentType: 'application/json', body: '{"status":"refused"}' }));
    if (width === 390) {
      await page.getByRole('button', { name: 'Session panel', exact: true }).focus();
      await page.keyboard.press('Enter');
    }
    const entry = page.getByRole('button', { name: 'Watch your computer', exact: true });
    await entry.waitFor({ timeout: 5000 });
    const target = await entry.boundingBox(); assert(target.width >= 44 && target.height >= 44);
    await entry.focus(); await page.keyboard.press('Enter');
    const viewer = page.getByRole('dialog', { name: 'Computer view', exact: true });
    await viewer.getByText('Unavailable', { exact: true }).waitFor();
    assert((await viewer.innerText()).includes('shared-desktop grant'));
    assert.equal(await viewer.locator('canvas').count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await entry.evaluate(node => node === globalThis.document.activeElement), true);
    if (width === 390) await page.keyboard.press('Escape');
    await page.keyboard.press('Control+n');
    await page.getByText('Draft', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Watch your computer', exact: true }).count(), 0, 'A draft has no desktop entry');
    await page.close();
  }
  // Regression: constrain each column and its controls, even with an unbroken first message.
  const long = await open('long-title');
  for (const selector of ['.workspace-header', '.transcript', '.composer-dock', '#panel-toggle', '.send']) {
    const bounds = await long.page.locator(selector).boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= 390, `${selector} remains inside the phone: ${JSON.stringify(bounds)}`);
  }
  for (const selector of ['.main', '.workspace-header', '.transcript', '.composer-dock']) {
    assert(await long.page.locator(selector).evaluate(node => node.scrollWidth <= node.clientWidth), `${selector} contains its overflow`);
  }
  await long.page.close();
  // Regression: leaving a pending history read must give the draft a usable composer.
  const racing = await open('live', 1280);
  assert.equal(await racing.page.locator('.current-user strong').innerText(), 'Alex Morgan');
  let releaseHistory;
  const historyStarted = new Promise(resolve => {
    racing.page.route('**/api/conversations/research/messages?*', async route => {
      resolve();
      await new Promise(release => { releaseHistory = release; });
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ rows: [], position: 0, generation: 1, computerState: 'ready' }) });
    });
  });
  await racing.page.getByRole('button', { name: /county-rollout/ }).click();
  await historyStarted;
  await racing.page.getByRole('button', { name: /New session/ }).click();
  await racing.page.waitForFunction(() => !globalThis.document.querySelector('textarea').disabled, undefined, { timeout: 5000 });
  assert.equal(await racing.page.getByRole('textbox', { name: 'Message your agent' }).isEnabled(), true, 'Draft composer is enabled before old history returns');
  await racing.page.getByRole('textbox', { name: 'Message your agent' }).fill('Send from the new draft');
  await racing.page.getByRole('button', { name: 'Send message' }).click();
  await racing.page.getByRole('article', { name: 'Your message', exact: true }).filter({ hasText: 'Send from the new draft' }).waitFor();
  const oldHistory = racing.page.waitForResponse('**/api/conversations/research/messages?*');
  releaseHistory(); await (await oldHistory).finished(); await stable(racing.page);
  assert((await racing.page.locator('.transcript').innerText()).includes('Send from the new draft'));
  await racing.page.close();
  const unreachable = await open('rail-offline', 1280);
  await unreachable.page.getByText("Can't reach your pod", { exact: true }).waitFor({ timeout: 3000 });
  const countdown = await unreachable.page.locator('.retry-countdown').innerText();
  await unreachable.page.clock.runFor(1000);
  assert.notEqual(await unreachable.page.locator('.retry-countdown').innerText(), countdown);
  unreachable.fixture.online();
  await unreachable.page.getByRole('button', { name: 'Retry now' }).click();
  await unreachable.page.locator('.session-row').first().waitFor();
  await unreachable.page.close();
  const draft = await open('draft');
  await draft.page.getByRole('button', { name: 'Remove agent recipient' }).click({ timeout: 3000 });
  await draft.page.locator('#composer-reason').waitFor();
  assert.equal(await draft.page.getByRole('textbox', { name: 'Message your agent' }).isVisible(), false);
  await draft.page.getByRole('button', { name: 'Add your agent' }).click();
  await draft.page.getByRole('textbox', { name: 'Message your agent' }).fill('Draft recipient restored');
  await draft.page.getByRole('button', { name: 'Send message' }).click();
  await draft.page.getByRole('article', { name: 'Your message', exact: true }).filter({ hasText: 'Draft recipient restored' }).waitFor();
  await draft.page.close();
  console.log('PASS draft recipient selection');
  const activity = await open('tools', 1280);
  await activity.page.locator('.tool-line summary').first().click();
  assert(!(await activity.page.locator('.tool-line').first().innerText()).includes('a'.repeat(64)), 'Failure drawer never exposes a raw digest');
  await activity.page.getByRole('tab', { name: /Activity/ }).click();
  await activity.page.locator('.desktop-panel .activity-row').first().waitFor();
  assert.equal(await activity.page.locator('.desktop-panel .activity-row').count(), 2);
  await activity.page.locator('.desktop-panel .activity-row').first().click();
  assert.equal(await activity.page.locator('.tool-line').first().getAttribute('open'), '');
  activity.fixture.add('agent.turn_failed', { turnId: 'event-2', reason: 'provider failed' });
  await activity.page.locator('.desktop-panel .activity-row').filter({ hasText: 'Reply failed' }).waitFor();
  await activity.page.close();
  // Keyboard, streaming, Stop and replay all cross the rendered UI and the wire protocol.
  for (const width of [1280, 390]) {
    const { page, fixture } = await open('streaming', width);
    if (width === 390) {
      const stopButton = page.locator('oc-chat-composer')
        .getByRole('button', { name: 'Stop', exact: true });
      assert.equal(await stopButton.evaluate(button => button.scrollWidth <= button.clientWidth), true,
        'Stop label fits inside the phone button');
    }
    const composer = page.getByRole('textbox', { name: 'Message your agent' });
    await composer.focus(); await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('button', { name: 'Attach', exact: true }).evaluate(node => node === globalThis.document.activeElement), true);
    const ring = await page.getByRole('button', { name: 'Attach', exact: true }).evaluate(node => ({ width: globalThis.getComputedStyle(node).outlineWidth, colour: globalThis.getComputedStyle(node).outlineColor }));
    assert.equal(ring.width, '2px'); assert.equal(ring.colour, 'rgb(10, 132, 151)');
    await page.getByRole('region', { name: 'Conversation messages' }).focus();
    assert.equal(await page.locator(':focus').getAttribute('aria-label'), 'Conversation messages');
    fixture.add('decision.recorded', { turnId: 'event-2', reason: 'budget_exhausted' });
    await page.locator('oc-budget-stop-notice').waitFor();
    await page.reload(); await stable(page);
    const budgetNotice = page.locator('oc-budget-stop-notice');
    const budgetCopy = await budgetNotice.innerText();
    assert(budgetCopy.includes('Spending limit reached'));
    assert(budgetCopy.includes('An Owner or Admin can review the limit'));
    assert(budgetCopy.includes('next monthly budget period (UTC)'));
    assert(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
    fixture.conflictNextStop();
    await page.locator('oc-chat-composer').getByRole('button', { name: 'Stop', exact: true }).click();
    await page.getByText('Stopped · partial reply kept', { exact: false }).waitFor();
    fixture.add('agent.message_completed', { turnId: 'event-2', messageId: 'reply', text: 'SHOULD NOT REPLACE PARTIAL' });
    await page.reload(); await stable(page);
    assert(!(await page.locator('.transcript').innerText()).includes('SHOULD NOT'));
    assert((await page.locator('.transcript').innerText()).includes('Revenue is up 18%'));
    assert.equal(await page.locator('.progress').getAttribute('aria-live'), 'polite');
    assert.equal(await page.locator('[aria-label="Participants"]').count(), 0);
    await page.keyboard.press('Control+n'); await stable(page);
    await page.getByText('Draft', { exact: true }).waitFor();
    await composer.fill('Keyboard'); await stable(page); await page.keyboard.press('Shift+Enter'); await stable(page); await page.keyboard.type('message'); await stable(page); assert.equal(await composer.inputValue(), 'Keyboard\nmessage'); await page.keyboard.press('Enter');
    await page.getByRole('article', { name: 'Your message', exact: true }).filter({ hasText: 'Keyboard' }).waitFor();
    assert(fixture.commands.some(command => command.text === 'Keyboard\nmessage'));
    if (width === 390) {
      await page.getByRole('button', { name: 'Open session navigation' }).click();
      await page.getByRole('button', { name: /Ask your agent/ }).focus(); await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Session panel', exact: true }).click();
      await page.getByRole('dialog', { name: 'Session', exact: true }).waitFor(); await page.keyboard.press('Escape');
      assert.equal(await page.locator(':focus').getAttribute('id'), 'panel-toggle');
      for (const target of await page.locator('button:visible, summary:visible, textarea:visible').all()) {
        const box = await target.boundingBox(); assert(box.height >= 44 && box.width >= 44, `44px target: ${await target.getAttribute('aria-label')}`);
      }
    }
    assert(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
    const dock = await composer.boundingBox(); assert(dock.y + dock.height < (width === 390 ? 844 : 900));
    await page.close();
  }
  const rail = await open('streaming', 1280);
  assert.equal(await rail.page.locator('h1').innerText(), 'pull-the-q3-board');
  rail.fixture.add('agent.turn_completed', { turnId: 'event-2' });
  await rail.page.locator('.session-row.active').filter({ hasText: 'Done' }).waitFor();
  await rail.page.getByRole('button', { name: /county-rollout/ }).click();
  await stable(rail.page);
  assert((await rail.page.locator('.session-row').first().innerText()).includes('Done'), 'Completed status survives navigation');
  await rail.page.close();
  const queued = await open('queued');
  await queued.page.getByRole('textbox', { name: 'Message your agent' }).fill('Keep this draft');
  await queued.page.getByRole('button', { name: 'Send message' }).click();
  await queued.page.getByRole('button', { name: 'Retry queued message' }).waitFor();
  queued.fixture.online(); await queued.page.getByRole('button', { name: 'Retry queued message' }).click();
  await queued.page.getByRole('article', { name: 'Your message', exact: true }).filter({ hasText: 'Keep this draft' }).waitFor();
  assert.equal(queued.fixture.commands[0].id, queued.fixture.commands[1].id, 'Creation retry retains event id');
  await queued.page.close();
  const waking = await open('folding'); await waking.page.getByText('Starting your computer…', { exact: false }).waitFor();
  await waking.page.emulateMedia({ reducedMotion: 'no-preference' });
  assert(await waking.page.locator('oc-fold-loader').evaluate(node => node.getAnimations({ subtree: true }).length > 0), 'Fold animates while the agent works');
  waking.fixture.add('agent.message_delta', { turnId: 'event-2', messageId: 'reply', text: 'Streaming' });
  await waking.page.locator('.caret').waitFor();
  assert.equal(await waking.page.locator('.agent-turn').evaluate(node => globalThis.getComputedStyle(node).animationName), 'oc-unroll');
  await waking.page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await waking.page.locator('.caret').evaluate(node => globalThis.getComputedStyle(node).animationName), 'none');
  await waking.page.close();
  const frames = [ ['workspace-live', 'live'], ['7h', 'live'], ['8b', 'live'], ['8c', 'streaming'], ['8d', 'queued'], ['8e', 'assets'], ['8f', 'tools'], ['8h', 'a2ui'], ['8i', 'panel'], ['8j', 'compact'], ['12a', 'draft'], ['12b', 'no-agent'], ['1j', 'attach'], ['8c-fold', 'folding'], ['8d-disabled', 'closed'], ['8b-empty', 'draft'], ['8b-loading', 'rail-loading'], ['8b-offline', 'rail-offline'], ['8b-no-agent', 'no-agent'], ['8i-activity', 'tools'] ];
  if (capture) await mkdir(output, { recursive: true });
  const comparisons = [];
  for (const [frame, scenario] of frames) {
    const source = (await readdir('docs/design/chat/wireframes')).find(name => name.includes(`-${frame.split('-')[0]}-`));
    for (const width of [1280, 390]) {
      const { page } = await open(scenario, width);
      if (frame.startsWith('8b-') && width === 390) await page.getByRole('button', { name: 'Open session navigation' }).click();
      if (frame === '8i-activity') { if (width === 390) await page.getByRole('button', { name: 'Session panel', exact: true }).click(); await page.getByRole('tab', { name: /Activity/ }).click(); }
      if (scenario === 'attach') await page.getByRole('button', { name: 'Attach', exact: true }).click();
      if (scenario === 'queued') { await page.getByRole('textbox', { name: 'Message your agent' }).fill('Compare this brief against what we promised.'); await page.getByRole('button', { name: 'Send message' }).click(); await page.getByRole('button', { name: 'Retry queued message' }).waitFor(); }
      if (scenario === 'panel' && width === 390) await page.getByRole('button', { name: 'Session panel', exact: true }).click();
      if (scenario === 'tools' && frame !== '8i-activity') await page.locator('.tool-line summary').first().click();
      if (scenario === 'assets') { await page.locator('.file-card').getByRole('button', { name: /^Open (?!session files)/ }).click(); await page.getByText('Preview unavailable.', { exact: false }).waitFor(); }
      if (scenario === 'a2ui') {
        const badge = await page.locator('.a2ui .agent-badge').evaluate(agentBadgeStyle);
        assert.equal(badge.background, 'rgb(238, 250, 252)');
        assert(badge.fontFamily.includes('DM Mono'));
      }
      await page.evaluate(() => new Promise(resolve => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))));
      for (const selector of ['.workspace-header', '.transcript', '.composer-dock']) {
        const box = await page.locator(selector).boundingBox();
        assert(box.x >= 0 && box.x + box.width <= width, `${frame} ${selector} stays in the column`);
      }
      if (width === 390) {
        const header = await page.locator('.workspace-header').boundingBox(), transcript = await page.locator('.transcript').boundingBox(), dock = await page.locator('.composer-dock').boundingBox();
        assert(transcript.y >= header.y + header.height && transcript.y + transcript.height <= dock.y + 1, 'Transcript stays between header and dock');
        for (const target of await page.locator('button:visible, summary:visible, textarea:visible').all()) {
          if (await target.evaluate(node => node.classList.contains('citation'))) {
            assert(await target.evaluate(node => { const hit = globalThis.getComputedStyle(node, '::before'); return hit.width === '44px' && hit.height === '44px'; }), 'Citation has a 44px invisible target');
          } else {
            const box = await target.boundingBox(); assert(box.width >= 44 && box.height >= 44, `${frame} target is 44px: ${await target.getAttribute('aria-label') || await target.innerText()}`);
          }
        }
      }
      if (scenario === 'attach') {
        const menu = await page.locator('.attach-menu').boundingBox(), card = await page.locator('.composer').boundingBox();
        assert(menu.y + menu.height <= card.y - 8 && Math.abs(menu.x - card.x) <= 1, 'Attach menu sits above and aligns with the composer');
      }
      assert(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), `${frame} ${width} fits`);
      if (capture) {
        await page.screenshot({ path: `${output}/${frame}-${width}.jpg`, type: 'jpeg', quality: 82 });
        comparisons.push(`<section><h2>${frame} · ${width}px</h2><div class="pair"><figure><figcaption>Owner reference</figcaption><img src="${source ? '../wireframes/' + source : 'reference-live.png'}" alt="${frame} owner design"></figure><figure><figcaption>Built · protocol fixture${frame === '1j' ? ' · Connectors deferred; no scoped connector API.' : ''}</figcaption><img src="${frame}-${width}.jpg" alt="Built ${frame} at ${width}px"></figure></div></section>`);
      }
      await page.close();
    }
  }
  if (capture) {
    const reference = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await reference.goto(`file://${resolve('docs/design/chat/design/workspace-live.offline.html')}`);
    await reference.locator('[data-screen-label]').first().waitFor();
    await reference.evaluate(() => globalThis.document.fonts.ready);
    await reference.evaluate(() => Promise.all(globalThis.document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished)));
    await reference.screenshot({ path: `${output}/reference-live.png` }); await reference.close();
    await writeFile(`${output}/index.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Chat frame comparison</title><style>body{font:14px system-ui;margin:24px;background:#eceff0;color:#16191a}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0;min-width:0}img{max-width:100%;border:1px solid #d9dfe0}section{margin:40px 0}figcaption{margin-bottom:10px}@media(max-width:700px){.pair{grid-template-columns:1fr}}</style><h1>Chat · reference and build</h1><p>Playwright Chromium · 1280px and 390px · protocol fixtures, not live user data. Personal agent sessions only. The owner reference includes later-phase group, approval and upload controls; those are deliberately excluded. Files use the single-view preview design, with an honest unavailable state until file transport is delivered. Phone layouts apply the owner's responsive rules.</p>${comparisons.join('')}</html>`);
  }
  console.log('PASS Chromium: keyboard, focus, touch targets, streaming, Stop/reload, offline retry, wake state and every scoped frame at 1280/390');
} finally {
  await browser.close();
  if (web) {
    web.kill('SIGTERM');
    function reapWeb() {
      web.kill('SIGKILL');
    }
    const reap = setTimeout(reapWeb, 1000);
    reap.unref();
    try {
      await exited;
    } finally {
      clearTimeout(reap);
    }
  }
}
