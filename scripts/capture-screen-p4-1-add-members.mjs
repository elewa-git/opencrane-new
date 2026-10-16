import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const output = resolve('docs/process/screen-p4-1-add-members');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://members.opencrane.test';
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const grace = { memberId: 'grace', displayName: 'Grace Achieng', membershipSource: 'local' };
const group = { groupId: 'sales', name: 'Sales team', membershipSource: 'local',
  position: 0, payingGroupId: 'sales', members: [grace],
  access: { source: 'group_membership', conversationAccess: false,
    personalMemoryAccess: false, grants: [] } };
const joinedAt = '2026-10-01T00:00:00.000Z';
const candidates = [
  { memberId: 'grace', displayName: 'Grace Achieng', email: 'grace@example.test',
    role: 'member', status: 'joined', joinedAt, groups: [
      { groupId: 'sales', name: 'Sales team', membershipSource: 'local' }] },
  { memberId: 'graham', displayName: 'Graham Mwangi', email: 'graham@example.test',
    role: 'member', status: 'joined', joinedAt, groups: [] },
];

function directory() {
  const count = { status: 'current', value: 2 };
  return { rows: candidates, next: null, counts: { members: count, groups: count,
    pendingInvitations: count, acceptedInvitations: count }, checkedAt: joinedAt,
  projection: { content: 'current' }, permissions: { invite: true } };
}

async function serveAsset(route) {
  const pathname = new URL(route.request().url()).pathname;
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
    if (state.name === 'access-changed') {
      await route.fulfill({ status: 403, json: { status: 'refused' } });
      return;
    }
    await route.fulfill({ json: directory() });
    return;
  }
  if (url.pathname === '/api/groups/sales') {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      assert.equal(body.action, 'add');
      assert.equal(body.memberId, 'graham');
      assert.equal(typeof body.commandId, 'string');
      state.commandId = body.commandId;
      if (state.name === 'conflict') {
        await route.fulfill({ status: 409, json: { status: 'refused' } });
        return;
      }
      await route.fulfill({ json: { status: 'appended', groupId: 'sales',
        sequence: 1, changeId: 'change' } });
      return;
    }
    state.groupReads += 1;
    const members = state.groupReads > 1 && state.name === 'added'
      ? [grace, { memberId: 'graham', displayName: 'Graham Mwangi', membershipSource: 'local' }]
      : [grace];
    await route.fulfill({ json: { rows: [{ ...group, members }] } });
    return;
  }
  if (url.pathname.startsWith('/api/groups/sales/changes/')) {
    assert.equal(url.pathname, `/api/groups/sales/changes/${state.commandId}`);
    if (state.name === 'adding') {
      await route.fulfill({ status: 503, json: { status: 'unavailable' } });
      return;
    }
    await route.fulfill({ json: { status: 'appended', groupId: 'sales',
      sequence: 1, changeId: 'change',
      projection: { content: 'current', iam: 'current' } } });
    return;
  }
  await serveAsset(route);
}

async function checkLayout(page) {
  const layout = await page.evaluate(() => {
    const targets = globalThis.document.querySelectorAll(
      'main button, main input, main a.button');
    const small = [];
    for (const target of targets) {
      const bounds = target.getBoundingClientRect();
      if (bounds.width === 0 || bounds.height === 0) continue;
      if (bounds.width < 44 || bounds.height < 44) small.push(target.textContent?.trim());
    }
    return { overflow: globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
      small };
  });
  assert.equal(layout.overflow, false);
  assert.deepEqual(layout.small, []);
}

async function capture(browser, width, name) {
  const context = await browser.newContext({ viewport: { width, height: 900 },
    reducedMotion: 'reduce' });
  const page = await context.newPage();
  const state = { name, groupReads: 0, commandId: '' };
  await page.route('**/*', (route) => serve(route, state));
  await page.goto(`${origin}/org/people/groups/sales`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Add members' }).click();
  const field = page.getByPlaceholder('Search name or email');
  await field.fill('gra');
  if (name === 'access-changed') {
    await page.getByText('Your access changed').waitFor();
    const text = await page.locator('main').innerText();
    assert.equal(text.includes('Sales team'), false);
    assert.equal(text.includes('Graham Mwangi'), false);
  } else {
    await page.getByRole('button', { name: 'Add', exact: true }).waitFor();
    if (name !== 'search') {
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      if (name === 'conflict') {
        await page.getByText('Membership changed while you were looking').waitFor();
        assert.equal(await page.getByRole('button', { name: 'Add', exact: true }).isDisabled(),
          true);
      } else if (name === 'added') {
        await page.getByText('Added Graham Mwangi to Sales team').waitFor();
        await page.getByRole('button', { name: 'Added' }).last().waitFor();
      } else {
        await page.getByText('Adding Graham Mwangi to Sales team…').waitFor();
        assert.equal(await page.getByRole('button', { name: 'Add', exact: true }).isDisabled(),
          true);
        assert.equal(await page.getByRole('button', { name: 'Remove' }).isDisabled(), true);
      }
    }
  }
  await checkLayout(page);
  await page.screenshot({ path: resolve(output, `${name}-${width}.png`), fullPage: true });
  await context.close();
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) {
    for (const name of ['search', 'adding', 'added', 'conflict', 'access-changed']) {
      await capture(browser, width, name);
    }
  }
} finally {
  await browser.close();
}
