import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const development = process.argv.includes('--development');
const build = resolve(`apps/web/dist/${development ? 'private-reply' : 'web'}/browser`);
const output = resolve('docs/process/p4-15-pr3l');
const origin = 'https://private-display.opencrane.test';
const syntheticText = '# A private plan\n\n**Synthetic plan** [1]\n\n'
  + '```mermaid\ngraph LR\nDraft --> Review\n```';

async function serveAssets(route) {
  await serveWebBuild(route, build);
}
async function openChat(page) {
  await page.route('**/*', serveAssets);
  const fixture = await chatFixture(page, 'empty-selected');
  await page.goto(`${origin}/workspace?conversation=chat`);
  await fixture.waitForReadySocket();
  await page.evaluate(waitForFonts);
  return fixture;
}
function deliver(fixture) {
  const question = { text: 'Show a short plan.', authorId: 'me' };
  const human = fixture.add('message.posted', question);
  const turn = { turnId: human.id, executionMode: 'restricted' };
  fixture.add('agent.turn_started', turn);
  const binding = { version: 1, topic: 'conversation', conversationId: 'chat',
    turnId: human.id, threadId: 'thread', generation: 7, inputGeneration: human.id };
  const reply = { ...binding, type: 'private_reply',
    data: { text: syntheticText, turnId: human.id } };
  fixture.sendFrame(reply);
  return { binding, reply, turn };
}
async function capture(page, name, width) {
  assert(await page.evaluate(pageHasNoOverflow), 'Page fits the viewport');
  const options = { path: resolve(output, `${name}-${width}.png`), fullPage: true };
  await page.screenshot(options);
}
async function assertCleared(page) {
  const markdown = page.locator('oc-assistant-markdown');
  await markdown.waitFor({ state: 'detached' });
  const markup = await page.locator('body').innerHTML();
  const accessible = await page.locator('body').ariaSnapshot();
  assert(!markup.includes('Synthetic plan'), 'Cleared text is absent');
  assert(!accessible.includes('Synthetic plan'), 'Cleared accessible text is absent');
  assert.equal(await page.locator('.oc-mermaid-renderer, img[alt="Diagram"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Citation 1' }).count(), 0);
}
async function displayAndClear(browser, width) {
  const options = { viewport: { width, height: 900 }, reducedMotion: 'reduce' };
  const page = await browser.newPage(options);
  const consoleMessages = [];
  function recordConsole(message) {
    consoleMessages.push(message.text());
  }
  page.on('console', recordConsole);
  try {
    const fixture = await openChat(page);
    const { binding, reply, turn } = deliver(fixture);
    const image = page.getByRole('img', { name: 'Diagram', exact: true });
    await image.waitFor();
    fixture.add('agent.output_lost', turn);
    fixture.add('agent.turn_completed', turn);
    fixture.sendFrame(reply);
    assert.equal(await page.locator('oc-assistant-markdown').count(), 1);
    const otherClearance = { ...binding, type: 'private_output_cleared', threadId: 'other' };
    fixture.sendFrame(otherClearance);
    await image.waitFor();
    await capture(page, 'live', width);
    const citation = page.getByRole('button', { name: 'Citation 1', exact: true });
    function hasTouchTarget(element) {
      const target = getComputedStyle(element, '::before');
      return parseFloat(target.height) >= 44 && parseFloat(target.width) >= 44;
    }
    assert(await citation.evaluate(hasTouchTarget), 'Citation target is 44 px');
    await citation.focus();
    const clearance = { ...binding, type: 'private_output_cleared' };
    fixture.sendFrame(clearance);
    await assertCleared(page);
    const transcript = page.getByRole('region', { name: 'Conversation messages' });
    function hasFocus(element) {
      return element === document.activeElement;
    }
    assert(await transcript.evaluate(hasFocus), 'Clearance preserves keyboard focus');
    await page.getByText('Reply unavailable', { exact: true }).waitFor();
    await capture(page, 'cleared', width);
    fixture.sendFrame(reply);
    await page.reload();
    await fixture.waitForReadySocket();
    await page.getByText('Reply unavailable', { exact: true }).waitFor();
    await assertCleared(page);
    assert.equal(fixture.commands.length, 0, 'Reload sends no command');
    const question = { text: 'Try a local file.', authorId: 'me' };
    const human = fixture.add('message.posted', question);
    const restricted = { turnId: human.id, executionMode: 'restricted' };
    fixture.add('agent.turn_started', restricted);
    const failure = { ...restricted, reason: 'restricted_tool_refused' };
    fixture.add('agent.turn_failed', failure);
    await page.getByText('Local file and browser writes are not available while private memory is loaded.',
      { exact: true }).waitFor();
    await page.getByText('Memory admission is disabled', { exact: true }).waitFor();
    await capture(page, 'restriction', width);
    function containsReply(message) {
      return message.includes('Synthetic plan') || message.includes('Draft --> Review');
    }
    assert(!consoleMessages.some(containsReply), 'Console contains no reply text');
  } finally {
    await page.close();
  }
}
async function cancelPendingDiagram(browser) {
  const page = await browser.newPage();
  let release;
  function hold(resolveHold) {
    release = resolveHold;
  }
  const pending = new Promise(hold);
  async function holdRenderer(route) {
    await pending;
    await serveAssets(route);
  }
  try {
    const fixture = await openChat(page);
    await page.route('**/mermaid-renderer.js', holdRenderer);
    const { binding } = deliver(fixture);
    await page.locator('.oc-mermaid-renderer').waitFor({ state: 'attached' });
    const clearance = { ...binding, type: 'private_output_cleared' };
    fixture.sendFrame(clearance);
    await assertCleared(page);
    release();
    await page.waitForLoadState('networkidle');
    await assertCleared(page);
  } finally {
    release();
    await page.close();
  }
}
const directoryOptions = { recursive: true };
await mkdir(output, directoryOptions);
const browser = await chromium.launch();
try {
  for (const width of [1280, 390]) await displayAndClear(browser, width);
  await cancelPendingDiagram(browser);
} finally {
  await browser.close();
}
console.log('PASS private reply display, clearance and captures at 1280 and 390 px');
