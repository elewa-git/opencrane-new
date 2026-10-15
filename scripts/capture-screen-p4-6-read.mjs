import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-p4-6-read');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://screen-p4-6-read.opencrane.test';
const directRow = {
  conversationId: 'group-chat', mode: 'group', participantIds: ['me', 'other'],
  createdBy: 'me', createdAt: '2026-10-14T00:00:00Z', title: 'Planning together',
  joinEventId: 'join-one', archived: false, archivePosition: 0, throughPosition: 0,
};
const sessionRow = {
  conversationId: 'session-chat', mode: 'agent_session', assistantId: 'assistant',
  createdBy: 'me', createdAt: '2026-10-14T00:00:00Z', title: 'Saved session',
  status: 'open', joinEventId: 'join-session', throughPosition: 0,
};
const message = {
  id: 'visible-message', position: 2, type: 'message.posted',
  time: '2026-10-14T00:00:00Z', data: { text: 'Can we meet tomorrow?', authorId: 'other' },
};

function holdSocket(socket) {
  socket.onMessage(ignoreSocketMessage);
}

function ignoreSocketMessage() {}

function nextMoment() {
  return new Promise(resolveNextMoment);
}

function resolveNextMoment(resolve) {
  setTimeout(resolve, 10);
}

function afterNextFrame() {
  return new Promise(requestAnimationFrame);
}

function isFocused(element) {
  return element === globalThis.document.activeElement;
}

function countSmallActions(controls) {
  let small = 0;
  for (const control of controls) {
    const bounds = control.getBoundingClientRect();
    if (bounds.width < 44 || bounds.height < 44
      || bounds.left < 0 || bounds.right > globalThis.innerWidth) small += 1;
  }
  return small;
}

async function serve(frame, readBodies, route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === '/auth/me') {
    await route.fulfill({ json: { authenticated: true, user: { name: 'Alex' } } });
    return;
  }
  if (url.pathname === '/api/chat') {
    await route.fulfill({ json: { memberId: 'me', assistantId: 'assistant' } });
    return;
  }
  if (url.pathname === '/api/chat/colleagues') {
    await route.fulfill({ json: { rows: [{ memberId: 'other', displayName: 'Grace' }],
      next: null } });
    return;
  }
  if (url.pathname.endsWith('/approvals')) {
    await route.fulfill({ json: { cards: [], csrf: 'fixture' } });
    return;
  }
  if (url.pathname === '/api/conversations') {
    await route.fulfill({ json: { rows: frame === 'workspace-clear' ? [sessionRow]
      : [directRow], nextCursor: null } });
    return;
  }
  if (url.pathname.endsWith('/messages')) {
    if (frame !== 'group-read') {
      await route.fulfill({ status: 403, json: {} });
      return;
    }
    await route.fulfill({ json: { rows: [message], position: 2,
      generation: 1, computerState: 'not_applicable' } });
    return;
  }
  if (url.pathname.endsWith('/state') && request.method() === 'POST') {
    readBodies.push(request.postDataJSON());
    await route.fulfill({ json: { status: 'appended', sequence: 2 } });
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    assert.fail(`Unexpected API route: ${url.pathname}`);
  }
  await serveWebBuild(route, build);
}

async function capture(browser, frame, width) {
  const page = await browser.newPage({ viewport: { width, height: 844 },
    reducedMotion: 'reduce' });
  const readBodies = [];
  await page.route('**/*', serve.bind(null, frame, readBodies));
  await page.routeWebSocket('**/ws', holdSocket);
  try {
    const path = frame === 'workspace-clear' ? '/workspace?conversation=session-chat'
      : '/workspace/direct?conversation=group-chat';
    await page.goto(`${origin}${path}`);
    if (frame === 'group-read') {
      await page.getByText('Can we meet tomorrow?').waitFor();
      for (let attempt = 0; attempt < 100 && readBodies.length === 0; attempt++) {
        await nextMoment();
      }
      assert.equal(readBodies.length, 1, 'One read command follows the rendered message');
      assert.deepEqual(Object.keys(readBodies[0]).sort(),
        ['action', 'id', 'joinEventId', 'throughEventId', 'throughPosition'].sort());
      assert.equal(readBodies[0].action, 'read');
      assert.equal(readBodies[0].joinEventId, 'join-one');
      assert.equal(readBodies[0].throughPosition, 2);
      assert.equal(readBodies[0].throughEventId, 'visible-message');
    } else {
      const notice = page.getByText('You no longer have access');
      await notice.waitFor();
      await page.evaluate(afterNextFrame);
      await page.evaluate(afterNextFrame);
      const bounds = await notice.boundingBox();
      assert(bounds && bounds.y >= 56 && bounds.y < 400,
        'The access notice stays near the top of the transcript');
      assert(bounds.y + bounds.height <= 844,
        'The complete access notice stays inside the viewport');
      const heading = page.getByRole('heading', { name: 'Unavailable' });
      assert.equal(await heading.count(), 1);
      const focusTarget = frame === 'workspace-clear'
        ? page.locator('.access-lock') : heading;
      assert(await focusTarget.evaluate(isFocused),
        'Focus moves to the unavailable notice');
      assert.equal(await page.locator('oc-chat-composer').count(), 0);
    }
    await page.evaluate(waitForFonts);
    if (frame === 'workspace-clear') {
      await page.evaluate(afterNextFrame);
      const notice = page.getByText('You no longer have access');
      const finalBounds = await notice.boundingBox();
      assert(finalBounds && finalBounds.y >= 56 && finalBounds.y + finalBounds.height <= 844,
        'The access notice remains inside the viewport after rendering');
    }
    assert(await page.evaluate(pageHasNoOverflow), `No overflow at ${width}px`);
    const small = await page.locator('.archive-button:visible, .participant-open:visible, '
      + '.refresh-button:visible, .navigation-toggle:visible').evaluateAll(countSmallActions);
    assert.equal(small, 0, `Visible actions fit inside ${width}px and meet 44px`);
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
  const filenames = [];
  for (const width of [1280, 390]) {
    for (const frame of ['direct-clear', 'workspace-clear', 'group-read']) {
      filenames.push(await capture(browser, frame, width));
    }
  }
  const receipt = '# Read and access-loss screens\n\n'
    + 'PASS: Intercepted pages at 1280px and 390px with reduced motion. '
    + 'Both unavailable screens and the open group chat have no horizontal overflow. '
    + 'The group chat sent one read command for its rendered message. '
    + 'Every visible header action fits inside the viewport and meets 44px. '
    + 'The complete lock notice remains in view after the next frame.\n\n'
    + `Captures: ${filenames.join(', ')}.\n`;
  await writeFile(`${output}/receipt.md`, receipt);
  console.log(`Captured ${filenames.length} screens`);
} finally {
  await browser.close();
}
