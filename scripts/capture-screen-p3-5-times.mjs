import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-p3-5-times');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://screen-p3-5-times.opencrane.test';
const requestedAt = '2026-10-04T10:14:00Z';
const decidedAt = '2026-10-04T10:16:00Z';
const usedAt = '2026-10-04T10:17:00Z';
const endedAt = '2026-10-04T10:19:00Z';
const conversation = {
  conversationId: 'chat', assistantId: 'assistant', mode: 'agent_session',
  createdBy: 'me', createdAt: requestedAt, title: 'Saved session', status: 'open',
};
const message = {
  id: 'message', position: 1, type: 'message.posted', time: requestedAt,
  data: { authorId: 'me', text: 'Help with the draft order.' },
};
const turnCompleted = {
  id: 'turn-completed', position: 2, type: 'agent.turn_completed', time: endedAt,
  data: { turnId: 'message' },
};
const review = {
  action: 'Change the note on SO-1042', tool: 'update_draft_order_note',
  target: 'Draft order SO-1042', data: '{"note":"Deliver after 10:00 on Tuesday"}',
  destination: 'erp.example.test', account: 'No account needed',
  consequence: 'Changes the draft note immediately.',
};
const baseCard = {
  approvalId: 'a'.repeat(64), conversationId: 'chat', requesterId: 'me',
  expiresAt: '2026-10-04T10:32:00Z', requestedAt,
  stepUp: false, canDecide: false, review,
};

function cardsFor(scene) {
  if (scene === 'WRK-16') {
    return [{ ...baseCard, state: 'outcome_unknown', decidedAt, usedAt,
      uses: [{ permitId: 'permit-1', usedAt }] }];
  }
  if (scene === 'WRK-17') return [{ ...baseCard, state: 'denied', decidedAt, endedAt }];
  if (scene === 'WRK-18') return [{ ...baseCard, state: 'expired', endedAt }];
  if (scene === 'WRK-19') {
    return [{ ...baseCard, state: 'cancelled', endedAt, cancelReason: 'new_message' }];
  }
  return [
    { ...baseCard, state: 'cancelled', endedAt, cancelReason: 'schema_changed' },
    { ...baseCard, approvalId: 'b'.repeat(64), state: 'cancelled', endedAt,
      cancelReason: 'grant_revoked' },
  ];
}

function rowAfterPosition(position, row) {
  return row.position > position;
}

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
    await route.fulfill({ json: { cards: cardsFor(scene), csrf: 'fixture' } });
    return;
  }
  if (url.pathname.endsWith('/messages')) {
    const since = Number(url.searchParams.get('since') ?? 0);
    const rows = [message, turnCompleted].filter(rowAfterPosition.bind(null, since));
    await route.fulfill({ json: { rows, position: 2, generation: 1,
      computerState: 'ready' } });
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    assert.fail(`Unexpected API request: ${url.pathname}`);
  }
  await serveWebBuild(route, build);
}

function smallTargets(controls) {
  const small = [];
  for (const control of controls) {
    const bounds = control.getBoundingClientRect();
    if (bounds.width < 44 || bounds.height < 44) small.push(control.outerHTML.slice(0, 100));
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
    const lines = page.locator('.approval-terminal');
    await lines.first().waitFor();
    const expectedCount = scene === 'WRK-20' ? 2 : 1;
    assert.equal(await lines.count(), expectedCount);
    assert.equal(await page.locator('.unknown-notice').count(), 0);
    await page.evaluate(waitForFonts);
    assert(await page.evaluate(pageHasNoOverflow), `${scene} overflows at ${width}px`);
    assert.deepEqual(await lines.evaluateAll(smallTargets), [],
      `${scene} approval lines meet 44px at ${width}px`);
    const composer = await page.locator('.composer-dock').boundingBox();
    assert(composer && composer.y + composer.height >= 800,
      `${scene} composer stays at the foot of the screen`);
    await page.screenshot({ path: `${output}/${scene}-${width}.png`, fullPage: true });
    if (scene === 'WRK-16' && width === 390) {
      await lines.first().click();
      const drawer = page.locator('oc-approval-cards oc-hinge-drawer dialog');
      await drawer.getByText('Result not confirmed').waitFor();
      assert((await drawer.textContent()).includes('Used'));
      assert((await drawer.textContent()).includes('Check status'));
      assert(await page.evaluate(pageHasNoOverflow), 'Approval details fit the phone');
      assert.deepEqual(await drawer.locator('button:visible').evaluateAll(smallTargets), [],
        'Phone details controls meet 44px');
      await page.screenshot({ path: `${output}/WRK-16-details-390.png` });
      await drawer.getByRole('button', { name: 'Back', exact: true }).click();
      assert(await lines.first().evaluate(isFocused), 'Back returns focus to the approval');
    }
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) {
    for (const scene of ['WRK-16', 'WRK-17', 'WRK-18', 'WRK-19', 'WRK-20']) {
      await capture(browser, scene, width);
    }
  }
  await writeFile(`${output}/receipt.md`, '# Saved approval times and reasons\n\n'
    + 'PASS: Captured five finished approval examples at 1280 px and 390 px with reduced '
    + 'motion and intercepted server replies. The used approval also has a phone detail '
    + 'capture. Each screen had no horizontal overflow, its approval controls met 44 px, '
    + 'the composer stayed docked, and Back returned focus to the used approval.\n\n'
    + 'These are browser fixture checks, not a fresh-install live journey.\n');
  console.log('Captured eleven finished approval screens');
} finally {
  await browser.close();
}
