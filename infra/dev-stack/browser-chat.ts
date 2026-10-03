/// <reference lib="dom" />
import { browserUploadJourney } from './browser-upload.ts';
import assert from 'node:assert/strict';
import { directory } from './config.ts';
import { secondary } from './identity.ts';
import { mkdir } from 'node:fs/promises';
import type { Page } from 'playwright';

/** The real signed-in member uses the shipped UI, HTTP commands and realtime bridge. */
export async function browserChatJourney(page: Page, origin: string, prompt = 'Say hello briefly.'): Promise<void> {
  await page.bringToFront();
  const start = performance.now();
  const width = page.viewportSize()!.width;
  const me = await (await page.request.get(`${origin}/auth/me`)).json() as { user: { name?: string } };
  const name = me.user.name?.trim();
  assert(name, 'Real sign-in supplies the profile name');
  await page.goto(origin);
  await page.getByRole('link', { name: 'Open workspace', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message your agent' }).waitFor();
  await page.waitForFunction(() => !globalThis.document.querySelector('.skeleton'));
  if (width === 1280) assert.equal(await page.locator('.current-user strong').innerText(), name);
  await page.keyboard.press('Control+n');
  await page.getByText('Draft', { exact: true }).waitFor();
  const composer = page.getByRole('textbox', { name: 'Message your agent' });
  const rendered = () => page.evaluate(() => new Promise<void>(resolve => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(() => resolve()))));
  await composer.fill(prompt); await rendered();
  const sentAt = performance.now();
  await composer.press('Enter');
  await page.locator('.caret').waitFor();
  const firstTokenMs = Math.round(performance.now() - sentAt);
  const reply = page.getByRole('article', { name: 'Agent reply', exact: true });
  await reply.filter({ hasText: 'Hello from your computer.' }).waitFor();
  await reply.getByText('Done', { exact: true }).waitFor();
  const completeMs = Math.round(performance.now() - sentAt);
  const url = page.url(); assert(new URL(url).searchParams.get('conversation'));
  await page.reload();
  await reply.filter({ hasText: 'Hello from your computer.' }).waitFor();
  await page.getByRole('article', { name: 'Your message', exact: true }).filter({ hasText: prompt }).waitFor();
  assert.equal(await reply.count(), 1, 'Reload has one completed reply');
  await composer.fill('Say hello again.'); await rendered(); await composer.press('Enter');
  await page.locator('.caret').waitFor();
  await page.locator('oc-chat-composer').getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByText('Stopped · partial reply kept', { exact: true }).waitFor();
  const partial = await reply.last().locator('.prose').innerText();
  assert(partial.length > 0 && partial.length < 'Hello from your computer.'.length, 'Stop keeps genuinely partial text');
  await page.reload();
  await page.getByText('Stopped · partial reply kept', { exact: true }).waitFor();
  assert.equal(await reply.last().locator('.prose').innerText(), partial);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished));
  });
  const screenshots = secondary ? directory : 'docs/design/chat/live';
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/workspace-${width}.png`, fullPage: true });
  await browserUploadJourney(page, origin, screenshots);
  console.log(`PASS browser chat ${width}px: sign-in → workspace → streamed stub reply → reload; Stop keeps partial text after reload; first token ${firstTokenMs} ms, completion ${completeMs} ms, browser journey ${Math.round(performance.now() - start)} ms; screenshot ${screenshots}/workspace-${width}.png`);
}
