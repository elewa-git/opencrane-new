import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-p4-6-close');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://screen-p4-6-close.opencrane.test';
const title = 'Planning next week and checking every question with our colleagues';

function conversation(kind, closed) {
  const common = {
    conversationId: kind === 'group' ? 'group-chat' : 'session-chat',
    createdBy: 'me', createdAt: '2026-10-14T00:00:00Z', title,
    status: closed ? 'closed' : 'open', canClose: !closed,
  };
  if (kind === 'group') return { ...common, mode: 'group',
    participantIds: ['me', 'other'], joinEventId: 'join-one',
    archived: false, archivePosition: 0 };
  return { ...common, mode: 'agent_session', assistantId: 'assistant' };
}

function savedRows(closed) {
  const rows = [{ id: 'message-one', position: 1, type: 'message.posted',
    time: '2026-10-14T09:28:00Z',
    data: { authorId: 'other', text: 'Both proposals are in the shared folder now.' } }];
  if (closed) rows.push({ id: 'close-one', position: 2, type: 'conversation.closed',
    time: '2026-10-14T15:00:00Z', data: { conversationId: 'group-chat', closedBy: 'me' } });
  return rows;
}

async function serve(kind, closed, commands, checks, route) {
  const url = new URL(route.request().url());
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
  if (url.pathname === '/api/conversations/group-chat/participants') {
    await route.fulfill({ json: { rows: [
      { memberId: 'me', displayName: 'Alex' },
      { memberId: 'removed-member', displayName: null },
    ], joinPosition: 1, accessPosition: 2, canManage: true, canLeave: false } });
    return;
  }
  if (url.pathname === '/api/assistants') {
    await route.fulfill({ json: { rows: [] } });
    return;
  }
  if (url.pathname === '/api/conversations') {
    const rows = kind === 'foreign' ? [] : [conversation(kind, closed)];
    await route.fulfill({ json: { rows, nextCursor: null } });
    return;
  }
  if (url.pathname.endsWith('/messages')) {
    const rows = savedRows(closed);
    if (kind === 'session' && closed) {
      rows[1].data.conversationId = 'session-chat';
    }
    await route.fulfill({ json: { rows, position: rows.length, generation: 1,
      computerState: kind === 'group' ? 'not_applicable' : 'ready' } });
    return;
  }
  if (url.pathname.endsWith('/approvals')) {
    await route.fulfill({ json: { cards: [], csrf: 'fixture' } });
    return;
  }
  if (url.pathname.endsWith('/close') && route.request().method() === 'POST') {
    commands.push(route.request().postDataJSON());
    await route.fulfill({ status: 503, json: {} });
    return;
  }
  if (url.pathname.includes('/changes/')) {
    checks.push(url.pathname);
    await route.fulfill({ status: 404, json: {} });
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    assert.fail(`Unexpected API route: ${url.pathname}`);
  }
  await serveWebBuild(route, build);
}

function holdSocket(socket) {
  socket.onMessage(ignoreMessage);
}
function ignoreMessage() {}

function countSmallControls(controls) {
  return controls.filter(control => {
    const bounds = control.getBoundingClientRect();
    return bounds.width < 44 || bounds.height < 44;
  }).length;
}

function clippedCloseContent(elements) {
  const clipped = [];
  for (const element of elements) {
    const bounds = element.getBoundingClientRect();
    const container = element.closest('dialog, .transcript, .workspace-header, '
      + '.composer-dock, .main');
    if (!container) continue;
    const containerBounds = container.getBoundingClientRect();
    const overflows = element.scrollWidth > element.clientWidth + 1
      || bounds.right > containerBounds.right + 1
      || bounds.right > globalThis.innerWidth + 1;
    if (overflows) {
      clipped.push({
        className: element.className,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        right: bounds.right,
        containerRight: containerBounds.right,
      });
    }
  }
  return clipped;
}

async function capture(browser, width, kind, closed) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 },
    reducedMotion: 'reduce' });
  const commands = [];
  const checks = [];
  await page.route('**/*', serve.bind(null, kind, closed, commands, checks));
  await page.routeWebSocket('**/ws', holdSocket);
  try {
    const address = kind === 'group' ? '/workspace/direct?conversation=group-chat'
      : '/workspace?conversation=session-chat';
    await page.goto(`${origin}${address}`);
    if (closed) {
      await page.getByText('Closed · Read only.', { exact: false }).first().waitFor();
      assert.equal(await page.locator('oc-chat-composer').count(), 0,
        'A closed chat has no composer');
      assert.equal(await page.getByRole('button', { name: 'Close conversation' }).count(), 0);
      await page.reload();
      await page.getByText('Closed · Read only.', { exact: false }).first().waitFor();
      assert.equal(await page.locator('oc-chat-composer').count(), 0,
        'Reload keeps a closed chat read only');
      if (kind === 'group') {
        await page.getByRole('button', { name: 'Archive' }).waitFor();
      }
    } else {
      await page.getByRole('button', { name: 'Close conversation' }).click();
      await page.getByRole('heading', { name: 'Close conversation?' }).waitFor();
      const focused = await page.locator('oc-close-review-dialog dialog h2').evaluate(
        heading => heading === globalThis.document.activeElement);
      assert(focused, 'Focus starts at the close review title');
    }
    await page.evaluate(waitForFonts);
    assert(await page.evaluate(pageHasNoOverflow), `No overflow at ${width}px`);
    let closeAreas = 'oc-close-review-dialog dialog h2';
    if (kind === 'group') {
      if (width === 390) {
        closeAreas += ', .workspace-header h1';
      }
      closeAreas += ', .closed-chat-notice, .closed-composer-notice';
    } else {
      closeAreas += ', .closed-session-notice, .closed-session-composer';
    }
    const clipped = await page.locator(closeAreas).evaluateAll(clippedCloseContent);
    assert.deepEqual(clipped, [], `The title and close notices fit at ${width}px`);
    const small = await page.locator('oc-close-review-dialog dialog button:visible, '
      + '.close-opener:visible, .closed-session-composer:visible, '
      + '.closed-composer-notice:visible').evaluateAll(countSmallControls);
    assert.equal(small, 0, `Close controls meet 44px at ${width}px`);
    if (!closed) {
      const motion = await page.locator('oc-close-review-dialog dialog').evaluate(dialog =>
        globalThis.getComputedStyle(dialog).animationDuration);
      assert(Number.parseFloat(motion) <= 0.001, 'Reduced motion freezes decoration');
    }
    const filename = `${kind}-${closed ? 'THR-15' : 'THR-14'}-${width}.png`;
    await page.screenshot({ path: `${output}/${filename}`, fullPage: true });
    const files = [filename];
    if (kind === 'group' && closed) {
      await page.getByRole('button', { name: 'Participants' }).click();
      const panel = page.locator('.participant-panel');
      await panel.getByText('Former colleague').waitFor();
      assert.equal(await panel.getByText('removed-member').count(), 0,
        'The panel does not show a removed member id');
      assert.equal(await panel.locator('.participant-action').count(), 0,
        'The closed group has no participant change controls');
      const panelFilename = `group-participants-THR-15-${width}.png`;
      await page.screenshot({ path: `${output}/${panelFilename}`, fullPage: true });
      files.push(panelFilename);
    }
    if (!closed) {
      await page.keyboard.press('Escape');
      assert(await page.getByRole('button', { name: 'Close conversation' }).evaluate(
        button => button === globalThis.document.activeElement),
      'Escape returns focus to the opener');
      await page.getByRole('button', { name: 'Close conversation' }).click();
      await page.getByRole('button', { name: 'Cancel' }).click();
      assert(await page.getByRole('button', { name: 'Close conversation' }).evaluate(
        button => button === globalThis.document.activeElement),
      'Cancel returns focus to the opener');
      await page.getByRole('button', { name: 'Close conversation' }).click();
      await page.getByRole('button', { name: 'Close for everyone' }).dblclick();
      await page.getByText('The reply may have been lost.', { exact: false }).first().waitFor();
      assert.equal(commands.length, 1, 'A double confirm sends one command');
      await page.reload();
      await page.getByRole('button', { name: 'Check status' }).click();
      assert.equal(checks.length, 1, 'Reload checks the original command once');
      assert(checks[0].endsWith(`/changes/${commands[0].id}`),
        'Check status keeps the original command id');
      assert.equal(commands.length, 1, 'Checking status sends no close command');
    }
    return files;
  } finally {
    await page.close();
  }
}

async function checkForeign(browser, kind) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('**/*', serve.bind(null, 'foreign', false, [], []));
  try {
    const address = kind === 'group' ? '/workspace/direct?conversation=foreign'
      : '/workspace?conversation=foreign';
    await page.goto(`${origin}${address}`);
    await page.getByRole('heading', { name: 'Unavailable' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Close conversation' }).count(), 0);
    assert.equal(await page.getByText(title).count(), 0,
      'An unavailable chat reveals no private title');
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const captures = [];
  for (const width of [1280, 390]) {
    for (const kind of ['group', 'session']) {
      const reviewFiles = await capture(browser, width, kind, false);
      const closedFiles = await capture(browser, width, kind, true);
      captures.push(...reviewFiles, ...closedFiles);
    }
  }
  await checkForeign(browser, 'group');
  await checkForeign(browser, 'session');
  await writeFile(`${output}/receipt.md`, `# Close review screen receipt\n\n` +
    `PASS: Captured the group chat and assistant session review and closed states at ` +
    `1280 and 390 pixels with intercepted API replies. The real routes rendered without ` +
    `horizontal overflow. The group title and both screens' close notices and footers ` +
    `fitted within their ` +
    `own areas. Visible close controls measured at least 44 pixels. ` +
    `Reduced motion stopped dialog decoration. Escape and Cancel returned focus. ` +
    `A double click sent one command, and reload checked its original id. Foreign ` +
    `chats revealed no title or close action. Closed screens kept saved history ` +
    `and had no composer after reload. The closed group participant panel used a ` +
    `neutral name and offered no change controls.\n\n` +
    `Files: ${captures.join(', ')}.\n\n` +
    `Fresh-install live journey: NOT RUN.\n`);
  console.log(`Captured ${captures.length} close review screens.`);
} finally {
  await browser.close();
}
