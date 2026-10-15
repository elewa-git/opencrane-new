import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-p4-23-explain');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://screen-p4-23-explain.opencrane.test';
const address = '/org/integrations/odoo/access/explanation' +
  '?requester=alex&assistant=helper&tool=update_draft_order_note';
const longName = 'A'.repeat(200);
const source = { kind: 'group', groupId: 'sales', groupName: longName,
  eventId: 'event-1', sequence: 1 };
const assistantSource = { kind: 'assistant', granteeKind: 'assistant',
  granteeId: 'helper', eventId: 'event-2', sequence: 2 };
const base = {
  serverId: 'odoo', requesterId: 'alex', assistantId: 'helper',
  toolName: 'update_draft_order_note', checkedAt: '2026-10-04T08:40:00.000Z',
  person: 'allowed', assistant: 'allowed', actsFor: 'allowed',
  profile: 'absent_on_version', mode: 'ask', review: 'current',
  publication: 'unavailable', freshness: 'current', policySequence: 4,
  policyRevision: 3, catalogueCheckedAt: '2026-10-04T08:30:00.000Z',
  catalogueExpiresAt: '2026-10-04T09:30:00.000Z', availability: 'unavailable',
  sources: [source, assistantSource], complete: false, unavailableSections: [],
  reviewRevision: 'revision-1', reasons: ['publication_unavailable'],
};
const missing = {
  serverId: base.serverId, requesterId: base.requesterId,
  assistantId: base.assistantId, toolName: base.toolName, checkedAt: base.checkedAt,
  person: 'allowed', assistant: 'denied', actsFor: 'allowed',
  availability: 'unavailable', complete: false, reasons: ['missing_assistant_grant'],
};

async function servePage(state, route) {
  const url = new URL(route.request().url());
  if (url.pathname.startsWith('/api/') && url.pathname.endsWith('/access/explanation')) {
    assert.equal(url.searchParams.get('requesterId'), 'alex');
    assert.equal(url.searchParams.get('assistantId'), 'helper');
    assert.equal(url.searchParams.get('toolName'), base.toolName);
    state.reads += 1;
    if (state.frame === '403' && state.reads > 1) {
      await route.fulfill({ status: 403, json: { status: 'refused' } });
    } else if (state.frame === '503') {
      await route.fulfill({ status: 503, json: { status: 'unavailable' } });
    } else if (state.frame === 'missing-grant' || state.frame === '403') {
      await route.fulfill({ json: missing });
    } else if (state.frame === 'check-unavailable') {
      await route.fulfill({ json: { ...base, assistant: 'unavailable',
        profile: 'unavailable', sources: [source], reasons: ['iam_unavailable'] } });
    } else {
      await route.fulfill({ json: { ...base, profile: 'not_required' } });
    }
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    assert.fail(`Unexpected API request: ${url.pathname}`);
  }
  await serveWebBuild(route, build);
}

async function capture(browser, width, frame) {
  const page = await browser.newPage({
    viewport: { width, height: width === 1280 ? 900 : 844 }, reducedMotion: 'reduce',
  });
  const state = { frame, reads: 0 };
  await page.route('**/*', servePage.bind(null, state));
  try {
    await page.goto(`${origin}${address}`);
    if (frame === '503') {
      await page.getByText("We couldn't check access just now.", { exact: false }).waitFor();
    } else {
      await page.getByText('Checked 4 Oct 2026, 08:40 UTC').waitFor();
    }
    if (frame === '403') {
      await page.getByRole('button', { name: 'Refresh' }).click();
      await page.getByRole('heading', { name: 'Access refused' }).waitFor();
      const body = await page.locator('main').innerText();
      assert(!body.includes(base.toolName));
      assert(!body.includes('This person'));
      assert(!body.includes('Missing'));
    }
    await page.evaluate(waitForFonts);
    assert(await page.evaluate(pageHasNoOverflow), `No horizontal overflow at ${width}px`);
    const small = await page.locator('main button:visible, main a:visible')
      .evaluateAll(controls => controls.filter(control => {
        const bounds = control.getBoundingClientRect();
        return Math.round(bounds.width) < 44 || Math.round(bounds.height) < 44;
      }).map(control => control.tagName));
    assert.deepEqual(small, [], `Visible targets meet 44px at ${width}px`);
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
    for (const frame of ['missing-grant', 'all-granted', 'check-unavailable', '503', '403']) {
      captures.push(await capture(browser, width, frame));
    }
  }
  const receipt = '# Tool access explanation screens\n\n' +
    'PASS: Captured missing grant, all granted, check unavailable, 503 and 403 at ' +
    '1280 and 390 pixels. The phone uses labelled cards in place of the table. ' +
    'Server grants use integration wording. Publishing remains unavailable. ' +
    'A 403 clears the tool and names. Reduced motion, 44 pixel targets, long names ' +
    'and horizontal overflow were checked.\n\n' +
    `Files: ${captures.join(', ')}.\n`;
  await writeFile(`${output}/README.md`, receipt);
  console.log(`Captured ${captures.join(', ')}`);
} finally {
  await browser.close();
}
