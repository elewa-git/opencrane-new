import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-p4-6-list');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://screen-p4-6-list.opencrane.test';
const rows = [
  { conversationId: 'one', createdBy: 'me', assistantId: 'assistant',
    mode: 'agent_session', createdAt: '2026-10-14T00:00:00Z',
    title: 'A long conversation title that wraps at a narrow phone width' },
  { conversationId: 'two', mode: 'group', participantIds: ['me', 'other'],
    createdAt: '2026-10-13T00:00:00Z', title: 'Planning next week' },
];

async function servePage(state, route) {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/conversations') {
    if (state.frame === 'THR-01') {
      await route.fulfill({ json: { rows: [], nextCursor: null } });
      return;
    }
    if (url.searchParams.has('cursor')) {
      await new Promise(resolveRequest => { state.release = resolveRequest; });
      await route.fulfill({ json: { rows: [], nextCursor: null } });
      return;
    }
    await route.fulfill({ json: { rows, nextCursor: 'next' } });
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    assert.fail(`Unexpected API request: ${url.pathname}`);
  }
  await serveWebBuild(route, build);
}

async function capture(browser, width, frame) {
  const height = width === 1280 ? 900 : 844;
  const state = { frame, release: undefined };
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
  await page.route('**/*', servePage.bind(null, state));
  try {
    await page.goto(`${origin}/workspace/conversations`);
    if (frame === 'THR-01') {
      await page.getByLabel('Search conversations').fill('invoice');
      await page.getByRole('heading', { name: 'No matches' }).waitFor();
      await page.getByRole('button', { name: 'Clear search' }).waitFor();
    } else {
      await page.getByRole('button', { name: 'Load more' }).click();
      await page.getByText('Loading more…', { exact: true }).waitFor();
      await page.getByText(rows[0].title).waitFor();
    }
    await page.evaluate(waitForFonts);
    assert(await page.evaluate(pageHasNoOverflow), `No horizontal overflow at ${width}px`);
    const small = await page.locator('main button:visible, main input:visible, main a:visible')
      .evaluateAll(controls => controls.filter(control => {
        const bounds = control.getBoundingClientRect();
        return Math.round(bounds.width) < 44 || Math.round(bounds.height) < 44;
      }).map(control => control.tagName));
    assert.deepEqual(small, [], `Visible targets meet 44px at ${width}px`);
    const filename = `${frame}-${width}.png`;
    await page.screenshot({ path: `${output}/${filename}`, fullPage: true });
    return filename;
  } finally {
    state.release?.();
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const captures = [];
  for (const width of [1280, 390]) {
    captures.push(await capture(browser, width, 'THR-01'));
    captures.push(await capture(browser, width, 'THR-02'));
  }
  console.log(`Captured ${captures.join(', ')}`);
} finally {
  await browser.close();
}
