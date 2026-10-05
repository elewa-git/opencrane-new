import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const output = resolve('docs/process/p4-1-people');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://p4-1-people.opencrane.test';
const captures = [];
let emptyList = false;
let failList = false;
let holdList = false;
let releaseHeldList;
let refuseList = false;
let endSession = false;
let dropCreateReply = false;
const knownChanges = new Set();
const createBodies = [];
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const groups = [
  group('sales-team', 'Sales team', 'local', [
    member('alex-kim', 'Alex Kim', 'local'), member('grace-achieng', 'Grace Achieng', 'local'),
    member('jente-rosseel', 'Jente Rosseel', 'local'),
    member('marieke-vos', 'Marieke Vos', 'identity_provider'),
  ], [
    grant('mcp_server', 'odoo-community', 'use'), grant('model', 'gpt-6-1-sol', 'use'),
    grant('assistant', 'sales-assistant', 'acts_for'),
  ]),
  group('nairobi-office', 'Nairobi office', 'identity_provider', [
    member('marieke-vos', 'Marieke Vos', 'identity_provider'),
    member('alex-kim', 'Alex Kim', 'identity_provider'),
  ], []),
  group('regional-purchasing', 'Regional purchasing and supplier relationship coordination',
    'local', [member('peter-otieno', 'Peter Otieno', 'local')], []),
  group('long-id', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzABCDEFGH', 'local', [], []),
];
const initialGroups = [...groups];

function member(memberId, displayName, membershipSource) {
  return { memberId, displayName, membershipSource };
}
function grant(resourceType, resourceId, relation) { return { resourceType, resourceId, relation }; }
function group(groupId, name, membershipSource, members, grants) {
  return { groupId, name, membershipSource, position: 0, payingGroupId: groupId, members,
    access: { source: 'group_membership', conversationAccess: false,
      personalMemoryAccess: false, grants } };
}
function noOverflow() {
  return globalThis.document.documentElement.scrollWidth <= globalThis.window.innerWidth;
}
function everyTargetIsLarge() {
  const targets = [...globalThis.document.querySelectorAll(
    'main button, main a',
  )];
  const smallTargets = [];
  for (const target of targets) {
    const bounds = target.getBoundingClientRect();
    if (bounds.width === 0 && bounds.height === 0) continue;
    if (bounds.width < 44 || bounds.height < 44) {
      smallTargets.push({ text: target.textContent?.trim(), width: bounds.width, height: bounds.height });
    }
  }
  return smallTargets;
}
function focusRing(target) {
  target.focus();
  const style = globalThis.getComputedStyle(target);
  return [style.outlineWidth, style.outlineOffset];
}
async function serveAssets(route) {
  const url = new URL(route.request().url());
  const pathname = url.pathname;
  if (pathname.startsWith('/api/groups')) {
    await serveApi(route, pathname);
    return;
  }
  let filename = resolve(build, `.${pathname}`);
  if (!extname(pathname)) filename = resolve(build, 'index.html');
  if (!filename.startsWith(`${build}/`)) { await route.abort(); return; }
  const body = await readFile(filename);
  await route.fulfill({ body, contentType: contentTypes[extname(filename)] ?? 'application/octet-stream' });
}
async function serveApi(route, pathname) {
  const request = route.request();
  if (request.method() === 'GET' && pathname === '/api/groups') {
    if (holdList) await waitForListRelease();
    if (endSession) {
      await route.fulfill({ status: 401, json: { status: 'refused' } });
      return;
    }
    if (refuseList) {
      await route.fulfill({ status: 403, json: { status: 'refused' } });
      return;
    }
    if (failList) {
      await route.fulfill({ status: 503, json: { status: 'unavailable' } });
      return;
    }
    const rows = emptyList ? [] : groups;
    await route.fulfill({ json: { rows } });
    return;
  }
  const detail = /^\/api\/groups\/([^/]+)$/u.exec(pathname);
  if (request.method() === 'GET' && detail) {
    const found = groups.find(matchesGroup(decodeURIComponent(detail[1] ?? '')));
    await route.fulfill({ json: { rows: found ? [found] : [] } });
    return;
  }
  if (request.method() === 'POST' && pathname === '/api/groups') {
    const body = request.postDataJSON();
    createBodies.push(body);
    if (dropCreateReply) {
      dropCreateReply = false;
      await route.abort();
      return;
    }
    const created = group(body.groupId, body.name, 'local', [], []);
    groups.push(created);
    knownChanges.add(body.commandId);
    await route.fulfill({ json: { status: 'appended', groupId: body.groupId,
      sequence: 1, changeId: body.commandId } });
    return;
  }
  if (pathname.includes('/changes/')) {
    const changeId = pathname.split('/').at(-1);
    if (!knownChanges.has(changeId)) {
      await route.fulfill({ status: 404, json: { status: 'not_found' } });
      return;
    }
    await route.fulfill({ json: { status: 'appended', groupId: 'created', sequence: 1,
      changeId, projection: { content: 'current', iam: 'current' } } });
    return;
  }
  await route.fulfill({ status: 404, json: { status: 'not_found' } });
}
function waitForListRelease() {
  return new Promise(holdListUntilReleased);
}
function holdListUntilReleased(resolve) {
  releaseHeldList = resolve;
}
function releaseListRead() {
  holdList = false;
  if (releaseHeldList) releaseHeldList();
  releaseHeldList = undefined;
}
function matchesGroup(groupId) {
  return (row) => row.groupId === groupId;
}
async function capture(page, name, width, motion) {
  assert.equal(await page.evaluate(noOverflow), true, `${name} has no sideways overflow`);
  await page.screenshot({ path: resolve(output, `${name}-${width}-${motion}.png`), fullPage: true });
  captures.push({ name, width, motion });
}
async function visit(page, path) {
  await page.goto(`${origin}${path}`);
  await page.locator('main h1').waitFor();
}
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390, 320]) {
    for (const motion of ['no-preference', 'reduce']) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: motion });
      const page = await context.newPage();
      groups.splice(0, groups.length, ...initialGroups);
      knownChanges.clear();
      createBodies.length = 0;
      emptyList = false;
      failList = false;
      refuseList = false;
      endSession = false;
      dropCreateReply = false;
      holdList = true;
      await page.route('**/*', serveAssets);
      await page.goto(`${origin}/org/people`);
      await page.getByText('Loading groups…').waitFor();
      await capture(page, 'loading', width, motion);
      releaseListRead();
      await page.getByRole('list', { name: 'Groups' }).waitFor();
      assert.equal(await page.locator('.group-row').count(), 4);
      assert.equal(await page.getByText('Invite people', { exact: true }).count(), 0);
      if (width < 700) assert.deepEqual(await page.evaluate(everyTargetIsLarge), []);
      assert.deepEqual(await page.locator('.button.primary').first().evaluate(focusRing), ['2px', '2px']);
      await capture(page, 'list', width, motion);
      await page.getByRole('button', { name: 'New group', exact: true }).click();
      await page.getByLabel('Group name').fill('Sales team');
      assert.equal(await page.getByRole('button', { name: 'Create group' }).isDisabled(), true);
      assert.notEqual(await page.getByLabel('Group name').getAttribute('aria-describedby'), null);
      assert.deepEqual(await page.evaluate(everyTargetIsLarge), []);
      await capture(page, 'create-duplicate', width, motion);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'New group', exact: true }).focus();
      await page.locator('#group-search').fill('not a group');
      await page.getByRole('button', { name: 'Clear search' }).waitFor();
      await capture(page, 'no-match', width, motion);
      await page.getByRole('button', { name: 'Clear search' }).click();
      emptyList = true;
      await page.getByRole('button', { name: 'Refresh list' }).click();
      await page.getByRole('heading', { name: 'No groups yet' }).waitFor();
      await capture(page, 'empty', width, motion);
      emptyList = false;
      await page.getByRole('button', { name: 'Refresh list' }).click();
      await page.getByRole('list', { name: 'Groups' }).waitFor();
      failList = true;
      await page.getByRole('button', { name: 'Refresh list' }).first().click();
      await page.getByText('We couldn\'t refresh groups. Nothing changed because of this.')
        .waitFor();
      await capture(page, 'stale', width, motion);
      failList = false;
      await page.getByRole('button', { name: 'Refresh list' }).first().click();
      await page.getByRole('list', { name: 'Groups' }).waitFor();
      await page.getByRole('button', { name: 'New group', exact: true }).click();
      await page.getByLabel('Group name').fill('New group');
      await page.getByRole('button', { name: 'Create group' }).click();
      await page.getByText('Group “New group” created').waitFor();
      assert.equal(await page.locator('main [role="status"] time').count(), 0);
      await capture(page, 'created', width, motion);
      if (width === 390) {
        await page.getByRole('button', { name: 'Open organisation navigation' }).click();
        await page.getByRole('navigation', { name: 'Organisation settings' }).waitFor();
        await capture(page, 'menu', width, motion);
        await page.keyboard.press('Escape');
      }
      await visit(page, '/org/people/groups/sales-team');
      await page.getByText('Marieke Vos', { exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'Grants' }).count(), 1);
      await capture(page, 'detail-local', width, motion);
      await visit(page, '/org/people/groups/nairobi-office');
      assert.equal(await page.getByRole('button', { name: /Remove/u }).count(), 0);
      await capture(page, 'detail-supplied', width, motion);
      await visit(page, '/org/people/groups/long-id');
      await page.getByText('No members yet', { exact: true }).waitFor();
      await capture(page, 'detail-empty', width, motion);
      if (width === 1280) {
        await visit(page, '/org/people');
        refuseList = true;
        await page.getByRole('button', { name: 'Refresh list' }).click();
        await page.getByText('Your access changed').waitFor();
        assert.equal(await page.getByText('Alex Kim', { exact: true }).count(), 0);
        assert.equal(await page.getByText('Sales team', { exact: true }).count(), 0);
        await capture(page, 'access-changed', width, motion);
        refuseList = false;
        endSession = true;
        await visit(page, '/org/people');
        await page.getByText('Your session ended. Sign in again to continue.').waitFor();
        await capture(page, 'session-ended', width, motion);
        endSession = false;
        await visit(page, '/org/people');
        await page.getByRole('list', { name: 'Groups' }).waitFor();
        const firstBodyIndex = createBodies.length;
        dropCreateReply = true;
        await page.getByRole('button', { name: 'New group', exact: true }).click();
        await page.getByLabel('Group name').fill('Uncertain group');
        await page.getByRole('button', { name: 'Create group' }).click();
        await page.getByText('Couldn\'t confirm “Uncertain group” was created').waitFor();
        await capture(page, 'unknown', width, motion);
        const postsBeforeCheck = createBodies.length;
        await page.getByRole('button', { name: 'Check status' }).click();
        await page.getByText('No record of this change yet. It may still arrive.').waitFor();
        assert.equal(createBodies.length, postsBeforeCheck);
        await capture(page, 'unknown-not-found', width, motion);
        await page.getByRole('button', { name: 'Send the same request again' }).click();
        await page.getByText('Group “Uncertain group” created').waitFor();
        assert.deepEqual(createBodies[firstBodyIndex], createBodies[firstBodyIndex + 1]);
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
const visual = { result: 'PASS', widths: [1280, 390, 320],
  motion: ['no-preference', 'reduce'], captures, comparedFrames: [],
  environment: 'Built Angular assets; Chromium; in-memory sample API; no stack' };
await writeFile(resolve(output, 'visual.json'), `${JSON.stringify(visual, null, 2)}\n`);
console.log(`PASS P4-1 people: ${captures.length} captures`);
