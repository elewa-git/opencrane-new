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
  web = spawn(process.execPath, ['--experimental-strip-types', '--import', resolve('apps/server/test/support/ephemeral-ports.ts'), resolve('node_modules/@angular/cli/bin/ng.js'), 'serve', '--host', '127.0.0.1', '--port', '0'],
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
async function open(scenario, width = 390) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: 'reduce' });
  const fixture = await chatFixture(page, scenario);
  await page.goto(`${origin}/workspace${['draft', 'attach', 'no-agent', 'queued'].includes(scenario) ? '' : '?conversation=chat'}`);
  await stable(page); return { page, fixture };
}
try {
  // Keyboard, streaming, Stop and replay all cross the rendered UI and the wire protocol.
  for (const width of [1280, 390]) {
    const { page, fixture } = await open('streaming', width);
    const composer = page.getByRole('textbox', { name: 'Message your agent' });
    await composer.focus(); await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('button', { name: 'Attach', exact: true }).evaluate(node => node === globalThis.document.activeElement), true);
    const ring = await page.getByRole('button', { name: 'Attach', exact: true }).evaluate(node => ({ width: globalThis.getComputedStyle(node).outlineWidth, colour: globalThis.getComputedStyle(node).outlineColor }));
    assert.equal(ring.width, '2px'); assert.equal(ring.colour, 'rgb(10, 132, 151)');
    await page.getByRole('region', { name: 'Conversation messages' }).focus();
    assert.equal(await page.locator(':focus').getAttribute('aria-label'), 'Conversation messages');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.getByText('Stopped · partial reply kept', { exact: false }).waitFor();
    fixture.add('agent.message_completed', { turnId: 'event-2', messageId: 'reply', text: 'SHOULD NOT REPLACE PARTIAL' });
    await page.reload(); await stable(page);
    assert(!(await page.locator('.transcript').innerText()).includes('SHOULD NOT'));
    assert((await page.locator('.transcript').innerText()).includes('Revenue is up 18%'));
    assert.equal(await page.locator('.progress').getAttribute('aria-live'), 'polite');
    assert.equal(await page.locator('[aria-label="Participants"]').count(), 0);
    await page.keyboard.press('Control+n'); await stable(page);
    await page.getByRole('heading', { name: 'What shall we work on?' }).waitFor();
    await composer.fill('Keyboard'); await stable(page); await page.keyboard.press('Shift+Enter'); await stable(page); await page.keyboard.type('message'); await stable(page); assert.equal(await composer.inputValue(), 'Keyboard\nmessage'); await page.keyboard.press('Enter');
    await page.getByRole('article', { name: 'Your message', exact: true }).filter({ hasText: 'Keyboard' }).waitFor();
    assert(fixture.commands.some(command => command.text === 'Keyboard\nmessage'));
    if (width === 390) {
      await page.getByRole('button', { name: 'Open session navigation' }).click();
      await page.getByRole('button', { name: /Ask your agent/ }).focus(); await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Session panel', exact: true }).click();
      await page.getByRole('dialog', { name: 'Session panel' }).waitFor(); await page.keyboard.press('Escape');
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
  assert.equal(await waking.page.locator('.fold i').first().evaluate(node => globalThis.getComputedStyle(node).animationName), 'ocFold');
  waking.fixture.add('agent.message_delta', { turnId: 'event-2', messageId: 'reply', text: 'Streaming' });
  await waking.page.locator('.caret').waitFor();
  assert.equal(await waking.page.locator('.agent-turn').evaluate(node => globalThis.getComputedStyle(node).animationName), 'oc-unroll');
  await waking.page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await waking.page.locator('.caret').evaluate(node => globalThis.getComputedStyle(node).animationName), 'none');
  await waking.page.close();
  const frames = [ ['workspace-live', 'live'], ['7h', 'live'], ['8b', 'live'], ['8c', 'streaming'], ['8d', 'queued'], ['8e', 'assets'], ['8f', 'tools'], ['8h', 'a2ui'], ['8i', 'panel'], ['8j', 'compact'], ['12a', 'draft'], ['12b', 'draft'], ['1j', 'attach'], ['8c-fold', 'folding'], ['8d-disabled', 'closed'] ];
  if (capture) await mkdir(output, { recursive: true });
  const comparisons = [];
  for (const [frame, scenario] of frames) {
    const source = (await readdir('docs/design/chat/wireframes')).find(name => name.includes(`-${frame.split('-')[0]}-`));
    for (const width of [1280, 390]) {
      const { page } = await open(scenario, width);
      if (scenario === 'attach') await page.getByRole('button', { name: 'Attach', exact: true }).click();
      if (scenario === 'queued') { await page.getByRole('textbox', { name: 'Message your agent' }).fill('Compare this brief against what we promised.'); await page.getByRole('button', { name: 'Send message' }).click(); await page.getByRole('button', { name: 'Retry queued message' }).waitFor(); }
      if (scenario === 'panel' && width === 390) await page.getByRole('button', { name: 'Session panel', exact: true }).click();
      if (scenario === 'tools') await page.locator('.tool-line summary').first().click();
      if (scenario === 'assets') { await page.locator('.file-card').click(); await page.getByText('Preview unavailable.', { exact: false }).waitFor(); }
      assert(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), `${frame} ${width} fits`);
      if (capture) {
        await page.screenshot({ path: `${output}/${frame}-${width}.jpg`, type: 'jpeg', quality: 82 });
        comparisons.push(`<section><h2>${frame} · ${width}px</h2><div class="pair"><figure><figcaption>Owner reference</figcaption><img src="${source ? '../wireframes/' + source : 'reference-live.png'}" alt="${frame} owner design"></figure><figure><figcaption>Built · protocol fixture</figcaption><img src="${frame}-${width}.jpg" alt="Built ${frame} at ${width}px"></figure></div></section>`);
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
} finally { await browser.close(); if (web) { web.kill('SIGTERM'); await exited; } }
