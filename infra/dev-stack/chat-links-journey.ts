/// <reference lib="dom" />
import './journey-entry.ts';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { Locator, Page, Request, Route } from 'playwright';
import { loadAuthConfig } from '@opencrane/auth';
import { authEnv, readEnv, root } from './config.ts';
import { requireStageBStack } from './stage-b-guard.ts';
import { requireStandInJourney } from './journey-guard.ts';
import { browserSessions } from './browser-signin.ts';
import { sendUploadedMessage } from './browser-upload-message.ts';
import { chatLinksPrompt, chatLinksText } from './chat-links-model.ts';

const stackId = process.env['DEV_STACK_ID'];
assert(stackId);
await requireStageBStack(stackId, stackId, homedir(), root);
const settings = await readEnv('settings');
requireStandInJourney(settings);
const origin = settings['ORIGIN'];
assert(origin);
const output = 'docs/process/work-links-1225-s1';
await mkdir(output, { recursive: true });
const config = loadAuthConfig(await authEnv());
const sessions = await browserSessions(config, origin);

function hasNoOverflow(element: HTMLElement | SVGElement): boolean {
  return element.scrollWidth <= element.clientWidth;
}

function documentStartedAt(): number {
  return performance.timeOrigin;
}

function isFocused(element: HTMLElement | SVGElement): boolean {
  return document.activeElement === element;
}

async function remotePage(route: Route): Promise<void> {
  const reply = { contentType: 'text/plain', body: 'External link destination.' };
  await route.fulfill(reply);
}

async function checkMessage(message: Locator): Promise<void> {
  const links = message.locator('a');
  assert.equal(await links.count(), 5);
  const external = message.locator('a[target="_blank"]');
  assert.equal(await external.count(), 4);
  for (const link of await external.all()) {
    assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
    const href = await link.getAttribute('href');
    assert(href);
    assert(href.startsWith('https://') || href.startsWith('mailto:'));
    assert(!/[.,!?)]$/u.test(href));
  }
  assert.equal(await message.locator('code a').count(), 0);
  assert.equal(await message.locator('a[href^="http:"], a[href^="javascript:"]').count(), 0);
  assert.equal(await message.locator('a[href^="data:"], a[href^="unknown:"]').count(), 0);
  assert.equal(await message.locator('.workspace-file-link').count(), 4);
  assert.equal(await message.locator('.workspace-file-note').count(), 0);
}

async function checkExternalKeyboardLink(page: Page, message: Locator): Promise<void> {
  const link = message.getByRole('link', { name: 'https://example.test/guide', exact: true });
  await link.focus();
  assert(await link.evaluate(isFocused));
  const popupOpened = page.waitForEvent('popup');
  await link.press('Enter');
  const popup = await popupOpened;
  try {
    await popup.waitForURL('https://example.test/guide');
    assert.equal(await popup.evaluate('window.opener'), null);
  } finally {
    await popup.close();
  }
}

async function checkSharedFile(page: Page, message: Locator, width: number): Promise<void> {
  const links = message.locator('.workspace-file-link');
  for (const link of await links.all()) {
    await link.focus();
    await link.press('Enter');
    const preview = page.locator('oc-file-preview');
    await preview.getByText('Preview ready', { exact: true }).waitFor();
    assert.match(await preview.innerText(), /A shared file for the link check/u);
    const mask = page.locator('.current-user');
    const path = `${output}/file-${width}.png`;
    await page.screenshot({ path, fullPage: true, mask: [mask] });
    await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  }
}

async function checkAppNavigation(page: Page, message: Locator): Promise<void> {
  let documentRequests = 0;
  function navigated(request: Request): void {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      documentRequests += 1;
    }
  }
  const startedAt = await page.evaluate(documentStartedAt);
  page.on('request', navigated);
  try {
    await message.getByRole('link', { name: 'Preferences', exact: true }).click();
    await page.getByText('Personal preferences are not available yet.', { exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/account/preferences');
    assert.equal(await page.evaluate(documentStartedAt), startedAt);
    await page.goBack();
    await page.locator('.agent-turn .workspace-file-link').first().waitFor();
    assert.equal(await page.evaluate(documentStartedAt), startedAt);
    assert.equal(documentRequests, 0);
  } finally {
    page.off('request', navigated);
  }
}

async function checkRefusedFile(page: Page, width: number): Promise<void> {
  const composer = page.getByRole('textbox', { name: 'Message your agent' });
  await composer.fill('/workspace/artifacts/not-shared.txt');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const message = page.getByRole('article', { name: 'Your message', exact: true }).last();
  await message.getByText('not-shared.txt — not shared by the agent.', { exact: true }).waitFor();
  assert.equal(await message.locator('a, .workspace-file-link').count(), 0);
  const path = `${output}/refused-${width}.png`;
  await message.screenshot({ path });
  const reply = page.getByRole('article', { name: 'Agent reply', exact: true }).last();
  await reply.getByText('Done', { exact: true }).waitFor({ timeout: 120_000 });
}

async function checkWidth(page: Page): Promise<void> {
  const width = page.viewportSize()?.width;
  assert(width === 1280 || width === 390);
  await page.route('https://example.test/**', remotePage);
  await page.goto(`${origin}/workspace`);
  const composer = page.getByRole('textbox', { name: 'Message your agent' });
  await composer.waitFor();
  await page.keyboard.press('Control+n');
  await page.getByText('Draft', { exact: true }).waitFor();
  const prompt = chatLinksPrompt + '\n\n' + chatLinksText;
  await sendUploadedMessage(page, prompt, 'Visit https://example.test/guide');
  const member = page.getByRole('article', { name: 'Your message', exact: true });
  const assistant = page.getByRole('article', { name: 'Agent reply', exact: true });
  await member.locator('.workspace-file-link').first().waitFor();
  await assistant.locator('.workspace-file-link').first().waitFor();
  await checkMessage(member);
  await checkMessage(assistant);
  assert(await page.locator('html').evaluate(hasNoOverflow));
  assert(await page.locator('.transcript').evaluate(hasNoOverflow));
  await member.screenshot({ path: `${output}/member-${width}.png` });
  await assistant.screenshot({ path: `${output}/assistant-${width}.png` });
  await checkExternalKeyboardLink(page, member);
  await checkSharedFile(page, member, width);
  await checkSharedFile(page, assistant, width);
  await checkAppNavigation(page, assistant);
  await page.reload();
  await assistant.locator('.workspace-file-link').first().waitFor();
  await checkMessage(member);
  await checkMessage(assistant);
  await checkRefusedFile(page, width);
  console.log(`PASS chat links ${width}px: member and assistant links, punctuation, code, unsafe `
    + 'schemes, keyboard, wrapping, shared files, app navigation, history, reload and refusal');
}

try {
  for (const page of sessions.memberPages) {
    await checkWidth(page);
  }
} finally {
  await sessions.browser.close();
}
