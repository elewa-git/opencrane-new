/// <reference lib="dom" />
import assert from 'node:assert/strict';
import type { Page } from 'playwright';

/** The real signed-in member uses the shipped UI, HTTP commands and realtime bridge. */
export async function browserChatJourney(page: Page, origin: string): Promise<void> {
  await page.goto(origin);
  await page.getByRole('link', { name: 'Open workspace', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message your agent' }).waitFor();
  await page.waitForFunction(() => !globalThis.document.querySelector('.skeleton'));
  await page.keyboard.press('Control+n');
  await page.getByRole('heading', { name: 'What shall we work on?' }).waitFor();
  const composer = page.getByRole('textbox', { name: 'Message your agent' });
  const rendered = () => page.evaluate(() => new Promise<void>(resolve => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(() => resolve()))));
  await composer.fill('Say hello briefly.'); await rendered();
  await composer.press('Enter');
  await page.locator('.caret').waitFor();
  const reply = page.getByRole('article', { name: 'Agent reply', exact: true });
  await reply.filter({ hasText: 'Hello from your computer.' }).waitFor();
  await reply.getByText('✓ Done', { exact: true }).waitFor();
  const url = page.url(); assert(new URL(url).searchParams.get('conversation'));
  await page.reload();
  await reply.filter({ hasText: 'Hello from your computer.' }).waitFor();
  await page.getByRole('article', { name: 'Your message', exact: true }).filter({ hasText: 'Say hello briefly.' }).waitFor();
  assert.equal(await reply.count(), 1, 'Reload has one completed reply');
  await composer.fill('Say hello again.'); await rendered(); await composer.press('Enter');
  await page.locator('.caret').waitFor();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByText('■ Stopped · partial reply kept', { exact: true }).waitFor();
  const partial = await reply.last().locator('.prose').innerText();
  assert(partial.length > 0 && partial.length < 'Hello from your computer.'.length, 'Stop keeps genuinely partial text');
  await page.reload();
  await page.getByText('■ Stopped · partial reply kept', { exact: true }).waitFor();
  assert.equal(await reply.last().locator('.prose').innerText(), partial);
  console.log('PASS browser chat: real sign-in → workspace → streamed stub reply → reload; Stop keeps partial text after reload at 390px');
}
