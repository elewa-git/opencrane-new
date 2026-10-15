import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-p4-6-archive');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://screen-p4-6-archive.opencrane.test';
const title = 'Planning next week and checking every open question together';
const archivedRow = {
  conversationId: 'group-chat', mode: 'group', participantIds: ['me', 'other'],
  createdBy: 'me', createdAt: '2026-10-14T00:00:00Z', title,
  joinEventId: 'join-one', archived: true, archivePosition: 12,
};

async function servePage(frame, route) {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/chat') {
    await route.fulfill({ json: { memberId: 'me', assistantId: null } });
    return;
  }
  if (url.pathname === '/api/chat/colleagues') {
    await route.fulfill({ json: { rows: [{ memberId: 'other', displayName: 'Grace' }], next: null } });
    return;
  }
  if (url.pathname === '/api/conversations') {
    const section = url.searchParams.get('section');
    const rows = section === 'recent' ? [] : [archivedRow];
    await route.fulfill({ json: { rows, nextCursor: null } });
    return;
  }
  if (url.pathname.endsWith('/messages')) {
    await route.fulfill({ json: { rows: [{ id: 'message-one', position: 1,
      type: 'message.posted', time: '2026-10-14T00:00:00Z',
      data: { authorId: 'other', text: 'Shall we meet on Tuesday?', contentType: 'text' } }],
      position: 1, generation: 1, computerState: 'not_applicable' } });
    return;
  }
  if (url.pathname.endsWith('/state') && route.request().method() === 'POST') {
    await route.fulfill({ status: 503, json: {} });
    return;
  }
  if (url.pathname.includes('/changes/')) {
    await route.fulfill({ status: 404, json: {} });
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    assert.fail(`Unexpected API request: ${url.pathname}`);
  }
  await serveWebBuild(route, build);
}

async function capture(browser, width, frame) {
  const height = width === 1280 ? 900 : 844;
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
  await page.route('**/*', servePage.bind(null, frame));
  try {
    if (frame === 'archived-section') {
      await page.goto(`${origin}/workspace/conversations?section=archived`);
      await page.getByText(title).waitFor();
    } else {
      await page.goto(`${origin}/workspace/direct?conversation=group-chat`);
      await page.getByRole('button', { name: 'Unarchive' }).waitFor();
      const heading = page.locator('h1');
      const headingText = await heading.textContent();
      assert.equal(headingText?.trim(), title);
      assert.equal(await heading.getAttribute('title'), title);
      if (frame === 'unknown') {
        await page.getByRole('button', { name: 'Unarchive' }).click();
        await page.getByRole('button', { name: 'Check status' }).click();
        await page.getByText('No record of this change yet.').waitFor();
      } else {
        await page.getByText('You archived this conversation. Only your list changed.').waitFor();
      }
    }
    await page.evaluate(waitForFonts);
    assert(await page.evaluate(pageHasNoOverflow), `No horizontal overflow at ${width}px`);
    const small = await page.locator('.archive-button:visible, .archive-notice button:visible, '
      + '.sections button:visible, .conversation-list a:visible').evaluateAll(controls => {
      return controls.filter(control => {
        const bounds = control.getBoundingClientRect();
        return Math.round(bounds.width) < 44 || Math.round(bounds.height) < 44;
      }).map(control => control.tagName);
    });
    assert.deepEqual(small, [], `Archive targets meet 44px at ${width}px`);
    const filename = `${frame}-${width}.png`;
    await page.screenshot({ path: `${output}/${filename}`, fullPage: true });
    return filename;
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const captures = [];
  for (const width of [1280, 390]) {
    captures.push(await capture(browser, width, 'archived-chat'));
    captures.push(await capture(browser, width, 'unknown'));
    captures.push(await capture(browser, width, 'archived-section'));
  }
  console.log(`Captured ${captures.join(', ')}`);
} finally {
  await browser.close();
}
