import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const output = resolve('docs/process/screen-p4-3-invite');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://invite.opencrane.test';
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const count = { status: 'current', value: 1 };
const unavailable = { status: 'unavailable', value: null };
const owner = { memberId: 'jente', displayName: 'Jente', email: 'jente@elewa.ke',
  role: 'owner', status: 'joined', joinedAt: '2026-10-01T00:00:00Z', groups: [] };
const directory = { rows: [owner], next: null, counts: { members: count, groups: unavailable,
  pendingInvitations: unavailable, acceptedInvitations: unavailable },
checkedAt: '2026-10-15T12:00:00Z', projection: { content: 'current' },
permissions: { invite: true } };

async function serveAsset(route, pathname) {
  let filename = resolve(build, `.${pathname}`);
  if (!extname(pathname)) filename = resolve(build, 'index.html');
  if (!filename.startsWith(`${build}/`)) {
    await route.abort();
    return;
  }
  const body = await readFile(filename);
  await route.fulfill({ body, contentType: contentTypes[extname(filename)] ??
    'application/octet-stream' });
}

async function serve(route, state) {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/members') {
    await route.fulfill({ json: directory });
    return;
  }
  if (url.pathname === '/api/invitations/identity') {
    await route.fulfill({ json: { status: 'confirmation_on_acceptance',
      email: 'grace@example.test',
      message: 'The person is confirmed when they accept the invitation.' } });
    return;
  }
  if (url.pathname === '/api/invitations') {
    state.command = route.request().postDataJSON();
    if (state.frame === 'PPL-46') {
      await route.fulfill({ status: 503, json: { status: 'unavailable' } });
      return;
    }
    await route.fulfill({ json: { status: 'appended' } });
    return;
  }
  if (url.pathname.includes('/command-changes/')) {
    const command = state.command;
    const link = `${origin}/join/${command.memberId}/invitation-id`;
    await route.fulfill({ json: { status: 'recorded', commandId: command.commandId,
      result: { status: 'appended', memberId: command.memberId,
        invitationId: 'invitation-id', sequence: 1,
        createdAt: '2026-10-15T12:00:00Z', expiresAt: '2026-10-22T12:00:00Z',
        email: command.email, role: command.role,
        personalAssistant: command.personalAssistant, delivery: 'link_only', link } } });
    return;
  }
  await serveAsset(route, url.pathname);
}

async function checkLayout(page) {
  const layout = await page.evaluate(() => {
    const small = [];
    const targets = globalThis.document.querySelectorAll('main button, main a, main input, main select, '
      + 'dialog[open] button, dialog[open] input, dialog[open] select');
    for (const target of targets) {
      const bounds = target.getBoundingClientRect();
      if (bounds.width === 0 || bounds.height === 0) continue;
      if (bounds.width < 44 || bounds.height < 44) small.push(target.id || target.textContent?.trim());
    }
    return { overflow: globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
      small };
  });
  assert.equal(layout.overflow, false);
  assert.deepEqual(layout.small, []);
}

async function capture(browser, width, frame) {
  const context = await browser.newContext({ viewport: { width, height: 900 },
    reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
  const state = { frame, command: undefined };
  const page = await context.newPage();
  await page.route('**/*', (route) => serve(route, state));
  await page.goto(`${origin}/org/people`, { waitUntil: 'domcontentloaded' });
  const opener = page.getByRole('button', { name: 'Invite people' });
  await opener.waitFor();
  await opener.click();
  await page.waitForFunction(() => globalThis.document.activeElement?.id === 'invite-email');
  await page.locator('#invite-email').fill(frame === 'PPL-41' ? 'bad address' :
    'grace@example.test');
  if (frame !== 'PPL-40') {
    await page.getByRole('button', { name: 'Create', exact: true }).click();
  }
  if (frame === 'PPL-41') await page.locator('#invite-email-error').getByText(/valid email/u)
    .waitFor();
  if (frame === 'PPL-42' || frame === 'PPL-43') {
    await page.locator('#invitation-link').waitFor();
  }
  if (frame === 'PPL-43') {
    await page.getByRole('button', { name: 'Copy link' }).click();
    await page.getByText('Link copied').waitFor();
  }
  if (frame === 'PPL-46') await page.getByRole('button', { name: 'Check status' }).waitFor();
  await checkLayout(page);
  await page.screenshot({ path: resolve(output, `${frame}-${width}.png`), fullPage: true });
  if (frame === 'PPL-43') {
    await page.getByRole('button', { name: 'Done' }).click();
    assert.equal(await opener.evaluate((element) => globalThis.document.activeElement === element),
      true);
  }
  await context.close();
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) {
    for (const frame of ['PPL-40', 'PPL-41', 'PPL-42', 'PPL-43', 'PPL-46']) {
      await capture(browser, width, frame);
    }
  }
} finally {
  await browser.close();
}
