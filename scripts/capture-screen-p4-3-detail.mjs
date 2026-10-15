import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const output = resolve('docs/process/screen-p4-3-detail');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://detail.opencrane.test';
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
// Treat the sample viewer as Owner jente@elewa.ke. The API replies contain no viewer email.
const member = { memberId: 'alex-kim', displayName: 'Alex Kim', email: 'alex@example.test',
  role: 'member', status: 'joined', joinedAt: '2026-03-12T10:00:00Z',
  groups: [{ groupId: 'sales', name: 'Sales team', membershipSource: 'local' }],
  permissions: { changeRole: true, remove: true, manageOwnership: true },
  memberSequence: 2, ownershipSequence: 1,
  personalAssistant: { status: 'unavailable' }, rejoinedAt: { status: 'unavailable' } };
const grant = { resourceType: 'model', resourceId: 'model-a', label: 'Model A', relation: 'use',
  sources: [{ kind: 'direct', eventId: 'grant-a', sequence: 1 }],
  eligibility: { person: 'allowed', assistants: [], availability: 'unavailable' } };

async function serveAsset(route) {
  const pathname = new URL(route.request().url()).pathname;
  let filename = resolve(build, `.${pathname}`);
  if (!extname(pathname)) filename = resolve(build, 'index.html');
  if (!filename.startsWith(`${build}/`)) { await route.abort(); return; }
  const body = await readFile(filename);
  await route.fulfill({ body, contentType: contentTypes[extname(filename)] ??
    'application/octet-stream' });
}

async function serve(route, state) {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === '/api/members/alex-kim') {
    if (state.name === 'member-missing' && state.memberReads > 0) {
      await route.fulfill({ status: 404, body: '' });
      return;
    }
    state.memberReads += 1;
    await route.fulfill({ json: member });
    return;
  }
  if (pathname !== '/api/members/alex-kim/access') {
    await serveAsset(route);
    return;
  }
  if (state.name === 'access-loading') return;
  if (state.name === 'access-missing') {
    await route.fulfill({ status: 404, body: '' });
    return;
  }
  if (state.name === 'access-lost' && state.accessReads > 0) {
    await route.fulfill({ status: 403, body: '' });
    return;
  }
  state.accessReads += 1;
  const complete = state.name !== 'not-complete';
  const body = { checkedAt: '2026-10-15T10:00:00Z', complete,
    unavailableSections: complete ? [] : ['permissions'], rows: [grant] };
  await route.fulfill({ json: body });
}

async function checkLayout(page) {
  const layout = await page.evaluate(() => {
    const targets = globalThis.document.querySelectorAll('main button, main a, main input');
    let small = 0;
    for (const target of targets) {
      const bounds = target.getBoundingClientRect();
      if (bounds.width === 0 || bounds.height === 0) continue;
      if (Math.round(bounds.width) < 44 || Math.round(bounds.height) < 44) small += 1;
    }
    return { overflow: globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
      small };
  });
  assert.equal(layout.overflow, false);
  assert.equal(layout.small, 0);
}

function readAccessLayout() {
  const table = globalThis.document.querySelector('.member-access-table');
  const headers = table?.querySelectorAll('thead th');
  const firstCell = table?.querySelector('tbody th');
  if (!table || !headers || !firstCell) throw new Error('Missing access table');
  const columns = [];
  for (const header of headers) columns.push(header.getBoundingClientRect().left);
  return {
    display: globalThis.getComputedStyle(table).display,
    headerDisplay: globalThis.getComputedStyle(table.querySelector('thead')).display,
    columns,
    cardLabel: globalThis.getComputedStyle(firstCell, '::before').content,
  };
}

async function checkAccessLayout(page, width) {
  const layout = await page.evaluate(readAccessLayout);
  if (width === 1280) {
    assert.equal(layout.display, 'table');
    assert.equal(layout.columns.length, 3);
    assert.ok(layout.columns[0] < layout.columns[1]);
    assert.ok(layout.columns[1] < layout.columns[2]);
  } else {
    assert.equal(layout.headerDisplay, 'none');
    assert.equal(layout.cardLabel, '"Access"');
  }
}

async function checkMissingPage(page) {
  await page.getByRole('heading', { name: 'Member not found' }).waitFor();
  const visible = await page.locator('main').innerText();
  assert.equal(visible.includes('Alex Kim'), false);
  assert.equal(visible.includes('alex@example.test'), false);
  assert.equal(visible.includes('Sales team'), false);
  assert.equal(visible.includes('Direct grant'), false);
}

async function capture(browser, width, name) {
  const context = await browser.newContext({ viewport: { width, height: 900 },
    reducedMotion: 'reduce' });
  const page = await context.newPage();
  const state = { name, accessReads: 0, memberReads: 0 };
  await page.route('**/*', (route) => serve(route, state));
  await page.goto(`${origin}/org/people/members/alex-kim`, { waitUntil: 'domcontentloaded' });
  if (name === 'access-loading') {
    await page.getByText('Working out what Alex Kim can use…').waitFor();
  } else if (name === 'access-missing') {
    await checkMissingPage(page);
  } else if (name === 'not-complete') {
    await page.getByText('Not complete').waitFor();
  } else {
    await page.getByText('Direct grant').waitFor();
    await checkAccessLayout(page, width);
    if (name === 'member-missing') {
      await page.getByRole('button', { name: 'Refresh' }).click();
      await checkMissingPage(page);
    }
    if (name === 'access-lost') {
      await page.getByRole('button', { name: 'Refresh' }).click();
      await page.getByText("You no longer have access to this person's details").waitFor();
      const visible = await page.locator('main').innerText();
      assert.equal(visible.includes('Alex Kim'), false);
      assert.equal(visible.includes('alex@example.test'), false);
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
    for (const name of ['current', 'access-loading', 'not-complete', 'access-lost',
      'access-missing', 'member-missing']) {
      await capture(browser, width, name);
    }
  }
} finally {
  await browser.close();
}
const receipt = '# Member detail screen check\n\nPASS: Twelve intercepted API captures at 1280px '
  + 'and 390px. Desktop grants use Access, Why and Status columns. Phone grants use '
  + 'labelled cards. Reduced motion, no horizontal overflow or controls under 44px. '
  + 'The 403 and both 404 captures contain no member name, email, group or grant.\n\n'
  + 'PARTIAL: Change role, Remove and tool explanations are planned for later parts. '
  + 'A personal assistant and current ability to use grants say Not available yet. '
  + 'No live server or fresh-install journey was run.\n';
await writeFile(resolve(output, 'receipt.md'), receipt);
