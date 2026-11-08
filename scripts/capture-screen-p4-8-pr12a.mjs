import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-p4-8-pr12a');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://screen-p4-8-pr12a.opencrane.test';
const source = 'Compare the two delivery proposals and tell us which one fits next month.';
const conversation = { conversationId: 'group-chat', mode: 'group',
  participantIds: ['me', 'grace'], createdBy: 'me',
  createdAt: '2026-11-07T09:00:00Z', title: 'Sales team' };
const assistant = { assistantId: 'team-sales', kind: 'team', name: 'Sales assistant',
  canStartSession: true, status: 'ready' };

async function servePage(route) {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/chat') {
    await route.fulfill({ json: { memberId: 'me', displayName: 'Alex Kim', assistantId: null } });
    return;
  }
  if (url.pathname === '/api/chat/colleagues') {
    await route.fulfill({ json: { rows: [{ memberId: 'grace', displayName: 'Grace Achieng' }],
      next: null } });
    return;
  }
  if (url.pathname === '/api/chat/groups/sales-paying-group') {
    await route.fulfill({ json: { groupId: 'sales-paying-group', name: 'Sales team',
      position: 1, members: [] } });
    return;
  }
  if (url.pathname === '/api/conversations') {
    await route.fulfill({ json: { rows: [conversation], nextCursor: null } });
    return;
  }
  if (url.pathname.endsWith('/messages')) {
    await route.fulfill({ json: { rows: [
      { id: 'message-grace', position: 1, type: 'message.posted',
        time: '2026-11-07T09:28:00Z',
        data: { authorId: 'grace', text: 'Both proposals are in the shared folder now.',
          contentType: 'text' } },
      { id: 'message-me', position: 2, type: 'message.posted',
        time: '2026-11-07T09:30:00Z', data: { authorId: 'me', text: source,
          contentType: 'text' } },
    ], position: 2, generation: 1, computerState: 'not_applicable' } });
    return;
  }
  if (url.pathname === '/api/assistants') {
    await route.fulfill({ json: { rows: [assistant] } });
    return;
  }
  if (url.pathname.endsWith('/child-review')) {
    const body = route.request().postDataJSON();
    await route.fulfill({ json: { requestId: body.requestId,
      sourceMessageId: 'message-me', assistantId: 'team-sales',
      participantIds: ['me', 'grace'], payingGroupId: 'sales-paying-group',
      allowanceBoundCents: 1000, review: 'signed-review', expiresAt: Date.now() + 600_000 } });
    return;
  }
  if (url.pathname.startsWith('/api/')) assert.fail(`Unexpected API request: ${url.pathname}`);
  await serveWebBuild(route, build);
}

async function capture(browser, width, frame) {
  const height = width === 390 ? 844 : 900;
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    class FixtureWebSocket {
      readyState = 1;
      onopen = null;
      onclose = null;
      onerror = null;
      onmessage = null;
      constructor() {
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }
      send() {}
      close() {}
    }
    globalThis.WebSocket = FixtureWebSocket;
  });
  await page.route('**/*', servePage);
  try {
    await page.goto(`${origin}/workspace/direct?conversation=group-chat`);
    const action = page.getByRole('button', { name: /Ask Sales assistant to work on this/ });
    await action.waitFor();
    if (frame === 'guidance') {
      await page.locator('textarea').fill('@agent can you compare these?');
      await page.getByText('Typing @agent is plain text.').waitFor();
    } else {
      await action.click();
      await page.getByText('€10.00 for this work').waitFor();
      await page.getByText('Sales team · fixed for this work').waitFor();
      await page.getByRole('button', { name: 'Start child thread' }).waitFor();
      assert.equal(await page.locator('oc-modal-sheet dialog[open] header h2').evaluate(element =>
        element === globalThis.document.activeElement), true);
    }
    await page.evaluate(waitForFonts);
    assert(await page.evaluate(pageHasNoOverflow), `No horizontal overflow at ${width}px`);
    const small = await page.locator('oc-modal-sheet dialog[open] button:visible, '
      + '.child-review-action:visible, oc-modal-sheet dialog[open] select:visible')
      .evaluateAll(controls => controls.filter(control => {
        const bounds = control.getBoundingClientRect();
        return Math.round(bounds.width) < 44 || Math.round(bounds.height) < 44;
      }).map(control => control.tagName));
    assert.deepEqual(small, [], `Review targets meet 44 px at ${width}px`);
    const filename = `${frame}-${width}.png`;
    await page.screenshot({ path: `${output}/${filename}`, fullPage: true });
    if (frame === 'review') {
      await page.getByRole('button', { name: 'Cancel' }).last().click();
      assert.equal(await action.evaluate(element =>
        element === globalThis.document.activeElement), true);
    }
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
    captures.push(await capture(browser, width, 'guidance'));
    captures.push(await capture(browser, width, 'review'));
  }
  console.log(`Captured ${captures.join(', ')}`);
} finally {
  await browser.close();
}
