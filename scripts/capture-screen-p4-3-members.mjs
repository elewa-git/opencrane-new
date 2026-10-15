import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const output = resolve('docs/process/screen-p4-3-members');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://members.opencrane.test';
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const alice = { memberId: 'alice', displayName: 'Alice', email: 'alice@example.test',
  role: 'admin', status: 'joined', joinedAt: '2026-10-01T00:00:00Z', groups: [
    { groupId: 'sales', name: 'Sales team', membershipSource: 'local' }] };
const bob = { ...alice, memberId: 'bob', displayName: 'Bob', email: 'bob@example.test',
  role: 'member', groups: [] };

function directory(rows, next) {
  const count = { status: 'current', value: 2 };
  const unknown = { status: 'unavailable', value: null };
  return { rows, next, counts: { members: count, groups: unknown,
    pendingInvitations: unknown, acceptedInvitations: unknown },
  checkedAt: '2026-10-14T10:00:00Z', projection: { content: 'current' },
  permissions: { invite: true } };
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
  if (url.pathname !== '/api/members') {
    await serveAsset(route);
    return;
  }
  if (state.name === 'loading') return;
  if (state.name === 'first-failure' || state.reads > 0 && state.name === 'stale') {
    await route.fulfill({ status: 503, json: { status: 'unavailable' } });
    return;
  }
  if (state.reads > 0 && state.name === 'access-lost') {
    await route.fulfill({ status: 403, json: { status: 'refused' } });
    return;
  }
  state.reads += 1;
  let body = directory([alice], 'alice');
  if (state.name === 'no-matches') body = directory([], null);
  if (state.name === 'current' || state.name === 'stale' || state.name === 'access-lost') {
    body = directory([alice, bob], null);
  }
  if (state.name === 'load-more' && url.searchParams.get('after') === 'alice') {
    body = directory([alice, bob], null);
  }
  await route.fulfill({ json: body });
}

async function checkLayout(page) {
  const layout = await page.evaluate(() => {
    const targets = globalThis.document.querySelectorAll('main button, main a, main input');
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
  const state = { name, reads: 0 };
  await page.route('**/*', (route) => serve(route, state));
  await page.goto(`${origin}/org/people`, { waitUntil: 'domcontentloaded' });
  if (name === 'loading') await page.getByText('Loading members…').waitFor();
  if (name === 'first-failure') {
    await page.getByText('Members are unavailable right now').waitFor();
  }
  if (name === 'no-matches') {
    await page.locator('#member-search').fill('missing');
    await page.getByText('No members match your search').waitFor();
  }
  if (name === 'load-more') {
    await page.locator('[data-load-more]').click();
    await page.locator('[data-member-row]').nth(1).waitFor();
  }
  if (name === 'stale' || name === 'access-lost') {
    await page.locator('[data-member-row]').nth(1).waitFor();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    if (name === 'stale') await page.getByText('Showing what we loaded at',
      { exact: false }).waitFor();
    else {
      await page.getByText('Your access changed').waitFor();
      const body = await page.locator('main').innerText();
      assert.equal(body.includes('Alice'), false);
      assert.equal(body.includes('Bob'), false);
      assert.equal(body.includes('example.test'), false);
    }
  }
  if (name === 'current') await page.locator('[data-member-row]').nth(1).waitFor();
  await checkLayout(page);
  await page.screenshot({ path: resolve(output, `${name}-${width}.png`), fullPage: true });
  await context.close();
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390]) {
    for (const name of ['loading', 'current', 'load-more', 'no-matches',
      'stale', 'first-failure', 'access-lost']) {
      await capture(browser, width, name);
    }
  }
} finally {
  await browser.close();
}
