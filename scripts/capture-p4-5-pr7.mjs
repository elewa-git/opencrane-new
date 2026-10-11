import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/p4-5-pr7/captures');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://p4-5-pr7.opencrane.test';
const conversation = {
  conversationId: 'group-chat', createdBy: 'alice', createdAt: '2026-10-06T09:00:00Z',
  mode: 'group', participantIds: ['alice', 'bob', 'carol'],
};
const people = [
  { memberId: 'alice', displayName: 'Alex Kim' },
  { memberId: 'bob', displayName: 'Grace Achieng' },
  { memberId: 'carol', displayName: 'Chris Njeri' },
  { memberId: 'stale', displayName: null },
];

async function servePage(state, route) {
  const url = new URL(route.request().url());
  if (url.pathname.startsWith('/api/')) {
    await serveApi(state, route, url);
    return;
  }
  await serveWebBuild(route, build);
}

async function serveApi(state, route, url) {
  const pathname = url.pathname;
  if (pathname === '/api/chat') {
    await route.fulfill({ json: { memberId: 'alice', displayName: 'Alex Kim',
      assistantId: null } });
    return;
  }
  if (pathname === '/api/chat/groups') {
    await route.fulfill({ json: { rows: [], next: null } });
    return;
  }
  if (pathname === '/api/chat/colleagues') {
    await route.fulfill({ json: { rows: people, next: null } });
    return;
  }
  if (pathname === '/api/conversations') {
    await route.fulfill({ json: { rows: [conversation] } });
    return;
  }
  if (pathname.endsWith('/participants')) {
    await route.fulfill({ json: { rows: people, joinPosition: 1, accessPosition: 4,
      canManage: true, canLeave: false } });
    return;
  }
  if (pathname.endsWith('/messages')) {
    if (state === 'unavailable') {
      await route.fulfill({ status: 403, json: { status: 'refused' } });
      return;
    }
    const rows = [
      messageRow(1, 'bob', 'Is the Tuesday slot still open?'),
      messageRow(2, 'alice', 'Yes, I will confirm by noon.'),
    ];
    await route.fulfill({ json: { rows, position: 2, generation: 1,
      computerState: 'not_applicable' } });
    return;
  }
  assert.fail(`Unexpected chat request: ${pathname}`);
}

function messageRow(position, authorId, text) {
  return { id: `event-${position}`, position, type: 'message.posted',
    time: '2026-10-06T09:00:00Z',
    data: { authorId, text, contentType: 'text' } };
}

function attachConversationFeed(socket) {
  socket.onMessage(sendReady.bind(null, socket));
}

function sendReady(socket, raw) {
  const request = JSON.parse(String(raw));
  socket.send(JSON.stringify({ version: 1, topic: 'conversation',
    conversationId: request.conversationId, type: 'ready', position: 2,
    generation: 1, computerState: 'not_applicable' }));
}

async function capture(browser, width, state) {
  const height = width === 1280 ? 900 : 844;
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
  await page.route('**/*', servePage.bind(null, state));
  await page.routeWebSocket('**/ws', attachConversationFeed);
  const address = state === 'participants'
    ? `${origin}/workspace/direct?conversation=group-chat`
    : `${origin}/workspace/direct?conversation=group-chat`;
  try {
    await page.goto(address);
    if (state === 'participants') {
      await page.getByRole('button', { name: 'Participants' }).click();
      await page.getByRole('dialog', { name: 'Participants' }).waitFor();
    } else {
      await page.getByText('You no longer have access').waitFor();
    }
    await page.evaluate(waitForFonts);
    assert(await page.evaluate(pageHasNoOverflow), `No horizontal overflow at ${width}px`);
    const smallTargets = await page.locator('main button:visible, main input:visible').evaluateAll(
      controls => controls.filter(control => {
        const bounds = control.getBoundingClientRect();
        return Math.round(bounds.width) < 44 || Math.round(bounds.height) < 44;
      }).map(control => control.textContent?.trim() || control.tagName),
    );
    assert.deepEqual(smallTargets, [], `Visible controls meet 44px at ${width}px`);
    const frame = state === 'participants' ? 'THR-13' : 'THR-16';
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
    captures.push(await capture(browser, width, 'participants'));
    captures.push(await capture(browser, width, 'unavailable'));
  }
  console.log(`Captured ${captures.join(', ')}`);
} finally {
  await browser.close();
}
