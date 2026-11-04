import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/chat-tool-inline');
const build = resolve('apps/web/dist/web/browser');

async function serveAssets(route) {
  await serveWebBuild(route, build);
}

function buttonHasState({ id, state }) {
  return globalThis.document.getElementById(id)?.getAttribute('aria-expanded') === state;
}

async function waitForState(page, button, state) {
  const id = await button.getAttribute('id');
  await page.waitForFunction(buttonHasState, { id, state });
}

function addActivity(fixture) {
  const message = {
    text: 'Check the draft order.', authorId: 'me',
  };
  const question = fixture.add('message.posted', message);
  const turn = { turnId: question.id };
  fixture.add('agent.turn_started', turn);
  const command = {
    turnId: question.id, exitCode: 0, commandDigest: 'a'.repeat(64),
  };
  fixture.add('agent.command_ran', command);
  const toolStarted = {
    turnId: question.id, callId: 'tool-call-1',
    serverId: 'fixture-erp', toolName: 'read_order',
  };
  fixture.add('agent.tool_call_started', toolStarted);
  const toolFinished = {
    turnId: question.id, callId: 'tool-call-1',
    serverId: 'fixture-erp', toolName: 'read_order',
    status: 'completed', durationMs: 240,
  };
  fixture.add('agent.tool_call_finished', toolFinished);
  const reply = {
    turnId: question.id, messageId: 'reply',
    text: 'The draft order is ready for review.',
  };
  fixture.add('agent.message_delta', reply);
  fixture.add('agent.turn_completed', turn);
}

async function capture(browser, width) {
  const viewport = { width, height: 1000 };
  const pageOptions = { viewport, reducedMotion: 'reduce' };
  const page = await browser.newPage(pageOptions);
  try {
    await page.route('**/*', serveAssets);
    const fixture = await chatFixture(page, 'empty-selected');
    addActivity(fixture);
    await page.goto('https://chat.opencrane.test/workspace?conversation=chat');
    const command = page.getByRole('button', { name: /Command completed/ });
    const tool = page.getByRole('button', { name: /read_order/ });
    await command.waitFor();
    await tool.waitFor();
    await page.evaluate(waitForFonts);
    assert.equal(await command.getAttribute('aria-expanded'), 'false');
    assert.equal(await tool.getAttribute('aria-expanded'), 'false');
    const commandDetailsId = await command.getAttribute('aria-controls');
    assert(commandDetailsId, 'Command line names its inline details');
    const commandDetails = page.locator(`#${commandDetailsId}`);
    assert.equal(await commandDetails.count(), 1);
    assert.equal(await commandDetails.isVisible(), false);
    assert(await page.evaluate(pageHasNoOverflow));
    await page.screenshot({ path: resolve(output, `collapsed-${width}.png`), fullPage: true });

    await command.click();
    assert.equal(await command.getAttribute('aria-expanded'), 'true');
    const details = page.locator('.tool-details');
    const completedResult = details.getByText('Completed · Exit code 0');
    await completedResult.waitFor();
    assert.equal(await page.locator('oc-hinge-drawer[open]').count(), 0);
    assert(await page.evaluate(pageHasNoOverflow));
    await page.screenshot({ path: resolve(output, `expanded-${width}.png`), fullPage: true });

    await command.focus();
    await page.keyboard.press('Enter');
    await waitForState(page, command, 'false');
    await page.keyboard.press('Space');
    await waitForState(page, command, 'true');
    await page.keyboard.press('Space');
    await waitForState(page, command, 'false');

    await tool.focus();
    await page.keyboard.press('Enter');
    await waitForState(page, tool, 'true');
    const callResult = details.getByText('Call completed');
    await callResult.waitFor();
    await page.keyboard.press('Space');
    await waitForState(page, tool, 'false');
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) {
    await capture(browser, width);
  }
} finally {
  await browser.close();
}
console.log('PASS: intercepted inline tool details at 1280 and 390 px.');
