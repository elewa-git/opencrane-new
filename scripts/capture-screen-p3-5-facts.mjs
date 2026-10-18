import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-p3-5-facts');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://screen-p3-5-facts.opencrane.test';
const approvalId = 'a'.repeat(64);
const nativeRequestId = `native-request-92-${'x'.repeat(60)}`;
const time = '2026-10-16T10:00:00Z';
const conversation = {
  conversationId: 'chat', assistantId: 'assistant', mode: 'agent_session',
  createdBy: 'me', createdAt: time, title: 'Saved session', status: 'open',
};
const message = { id: 'message', position: 1, type: 'message.posted', time,
  data: { authorId: 'me', text: 'Help with the draft order.' } };
const nativeRefusal = { id: 'native-refusal', position: 2,
  type: 'agent.native_consent_refused', time, data: {
    conversationId: 'chat', turnId: 'message', nativeRequestId,
    serverName: 'Files server', reason: 'unsupported_native_consent',
  } };
const nativeReply = { id: 'native-reply', position: 3,
  type: 'agent.message_completed', time, data: {
    turnId: 'message', messageId: 'reply',
    text: 'I declined that native consent request. It granted no tool permission.',
  } };
const nativeTurnEnd = { id: 'native-turn-end', position: 4,
  type: 'agent.turn_completed', time, data: { turnId: 'message' } };
const approval = {
  approvalId, conversationId: 'chat', requesterId: 'me', expiresAt: '2026-10-16T10:32:00Z',
  state: 'requested', stepUp: false, canDecide: false, canApprove: false, canDeny: true,
  missingFields: ['orderId'], review: {
    action: 'Change the note on the draft order', tool: 'update_draft_order_note',
    target: '', data: '{"note":"Deliver after 10:00 on Tuesday"}',
    destination: 'erp.example.test', account: 'No account needed',
    consequence: 'Changes the draft note immediately.',
  },
};

function ignoreSocketMessage() {}

function holdSocket(socket) {
  socket.onMessage(ignoreSocketMessage);
}

async function serve(scene, route) {
  const url = new URL(route.request().url());
  if (url.pathname === '/auth/me') {
    await route.fulfill({ json: { authenticated: true, user: { name: 'Alex' } } });
    return;
  }
  if (url.pathname === '/api/chat') {
    await route.fulfill({ json: { memberId: 'me', assistantId: 'assistant' } });
    return;
  }
  if (url.pathname === '/api/conversations') {
    await route.fulfill({ json: { rows: [conversation], nextCursor: null } });
    return;
  }
  if (url.pathname.endsWith('/approvals')) {
    await route.fulfill({ json: { cards: scene === 'WRK-13' ? [approval] : [],
      csrf: 'fixture' } });
    return;
  }
  if (url.pathname.endsWith('/messages')) {
    const savedRows = scene === 'WRK-06'
      ? [message, nativeRefusal, nativeReply, nativeTurnEnd] : [message];
    const since = Number(url.searchParams.get('since') ?? 0);
    const rows = savedRows.filter(rowAfterPosition.bind(null, since));
    await route.fulfill({ json: { rows, position: savedRows.length, generation: 1,
      computerState: 'ready' } });
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    assert.fail(`Unexpected API request: ${url.pathname}`);
  }
  await serveWebBuild(route, build);
}

function rowAfterPosition(position, row) {
  return row.position > position;
}

function smallTargets(controls) {
  const small = [];
  for (const control of controls) {
    const bounds = control.getBoundingClientRect();
    if (bounds.width < 44 || bounds.height < 44) {
      small.push(control.outerHTML.slice(0, 100));
    }
  }
  return small;
}

function isFocused(element) {
  return element === globalThis.document.activeElement;
}

async function capture(browser, scene, width) {
  const page = await browser.newPage({ viewport: { width, height: 844 },
    reducedMotion: 'reduce' });
  await page.route('**/*', serve.bind(null, scene));
  await page.routeWebSocket('**/ws', holdSocket);
  try {
    await page.goto(`${origin}/workspace?conversation=chat`);
    if (scene === 'WRK-13') {
      await page.getByText('Missing reviewed fields: orderId', { exact: false }).waitFor();
      assert(await page.getByRole('button', { name: 'Approve:', exact: false }).isDisabled());
      assert(await page.getByRole('button', { name: 'Deny:', exact: false }).isEnabled());
    } else {
      await page.getByText(`Request ${nativeRequestId}`, { exact: false }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Approve:', exact: false }).count(), 0);
    }
    await page.evaluate(waitForFonts);
    assert(await page.evaluate(pageHasNoOverflow), `${scene} overflows at ${width}px`);
    const targets = scene === 'WRK-13' ? '.approval.pending button:visible'
      : '.tool-line:visible';
    assert.deepEqual(await page.locator(targets).evaluateAll(smallTargets), [],
      `${scene} actions meet 44px at ${width}px`);
    const composer = await page.locator('.composer-dock').boundingBox();
    assert(composer && composer.y + composer.height >= 800,
      `${scene} composer stays at the foot of the phone`);
    await page.screenshot({ path: `${output}/${scene}-${width}.png`, fullPage: true });
    if (scene === 'WRK-13' && width === 390) {
      await page.getByRole('button', { name: 'Deny:', exact: false }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${output}/${scene}-actions-${width}.png` });
    }
    if (scene === 'WRK-06') {
      const opener = page.locator('.tool-line');
      await opener.click();
      const drawer = page.locator('oc-hinge-drawer dialog').last();
      await drawer.getByText('No gateway permission was granted.', { exact: false }).waitFor();
      assert((await drawer.textContent()).includes(nativeRequestId));
      assert((await drawer.textContent()).includes('Turn reference'));
      if (width === 390) {
        const bounds = await drawer.boundingBox();
        assert(bounds && bounds.width >= 380, 'Phone details fill the screen');
      }
      await page.screenshot({ path: `${output}/${scene}-details-${width}.png` });
      await drawer.getByRole('button', { name: 'Back to conversation' }).click();
      assert(await opener.evaluate(isFocused),
        'Back returns focus to the refusal');
    }
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) {
    await capture(browser, 'WRK-06', width);
    await capture(browser, 'WRK-13', width);
  }
  await writeFile(`${output}/receipt.md`, '# Chat refusal and incomplete approval\n\n'
    + 'PASS: Captured example server replies at 1280 px and 390 px with reduced motion. '
    + 'The refusal uses its saved request reference. The incomplete review keeps Approve '
    + 'disabled and Deny available. The visible actions meet 44 px, the composer stays docked, '
    + 'a long request reference wraps without horizontal overflow, and Back returns '
    + 'focus to the refusal.\n\n'
    + 'Captures: WRK-06-1280.png, WRK-06-390.png, WRK-06-details-1280.png, '
    + 'WRK-06-details-390.png, WRK-13-1280.png, WRK-13-390.png, '
    + 'WRK-13-actions-390.png.\n');
  console.log('Captured seven chat screens');
} finally {
  await browser.close();
}
