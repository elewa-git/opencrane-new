/* global document */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-tools-access');
const time = new Date().toISOString();
const expiresAt = new Date(Date.now() + 300_000).toISOString();
const policy = { silo: 'test', serverId: 'fixture', sequence: 3, policyRevision: 2,
  connectionId: 'connection', accountMode: 'none', published: false, checkedAt: time, expiresAt,
  catalogue: { serverId: 'fixture', toolCount: 1, schemaDigest: 'b'.repeat(64),
    checkedAt: time, expiresAt, tools: [] },
  tools: [{ name: 'read_draft_order', revision: 'a'.repeat(64), reviewed: false,
    readOnly: true, mode: 'block', suggestion: 'allow', costCents: 0 }] };
const grant = { granteeKind: 'member', granteeId: 'alex', displayName: 'Alex Kim',
  source: 'direct', state: 'granted', eventId: 'person-grant', eventTime: time,
  sequence: 4, projection: 'current', iam: 'current', membershipStatus: 'joined' };
const access = { serverId: 'fixture', expectedSequence: 4, loadedAt: time, canManage: true,
  grants: [grant], complete: true, grantTotal: 1,
  projection: { content: 'current', iam: 'current', sequence: 4 } };
function choices(kind, next = null) {
  const row = kind === 'member' ? { id: 'alex', displayName: 'Alex Kim' }
    : { id: 'helper', displayName: 'Sales assistant' };
  return { rows: [row], next, loadedAt: time, projection: { content: 'current', sequence: 4 } };
}
function hasFocus(element) {
  return element === document.activeElement;
}
async function serve(state, route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === '/auth/me') return route.fulfill({ json: {
    authenticated: true, user: { email: 'owner@example.test', role: 'Owner' } } });
  if (!url.pathname.startsWith('/api/')) {
    return serveWebBuild(route, resolve('apps/web/dist/web/browser'));
  }
  if (url.pathname.endsWith('/tools')) return route.fulfill({ json: policy });
  if (request.method() === 'POST') {
    assert(url.pathname.endsWith('/access/changes'));
    state.posts += 1;
    state.command = request.postDataJSON();
    assert.equal(state.command.expectedSequence, 4);
    assert.equal(state.command.granteeKind, 'assistant');
    if (state.scene === 'conflict') return route.fulfill({ status: 409, json: {} });
    if (state.scene === 'no-effect') return route.fulfill({ json: { status: 'no_effect' } });
    return route.fulfill({ status: 202, json: { status: 'accepted' } });
  }
  if (url.pathname.includes('/changes/')) {
    assert(url.pathname.endsWith('/' + state.command.commandId));
    if (state.scene === 'unknown') return route.fulfill({ status: 404, json: { status: 'unknown' } });
    return route.fulfill({ json: { status: 'appended', serverId: 'fixture',
      commandId: state.command.commandId, operation: 'grant.given', sequence: 5,
      currentSequence: 5, changeId: 'change-one',
      projection: { content: state.scene === 'content-applying' ? 'applying' : 'current',
        iam: state.scene === 'applying' ? 'applying' : 'current' } } });
  }
  if (url.pathname.endsWith('/candidates')) {
    assert.equal(url.searchParams.get('limit'), '50');
    const kind = url.searchParams.get('kind');
    if (state.scene === 'cursor' && url.searchParams.has('after')
      || state.scene.startsWith('refused') && kind === 'member') {
      state.held = route;
      return;
    }
    if (state.scene.startsWith('refused')) {
      return route.fulfill({ status: Number(state.scene.slice(-3)), json: {} });
    }
    const body = choices(kind, state.scene === 'cursor' && kind === 'member' ? 'alex' : null);
    if (state.scene === 'empty') body.rows = [];
    return route.fulfill({ json: body });
  }
  assert(url.pathname.endsWith('/access'));
  if (state.scene === 'loading') return;
  if (state.scene === 'outage') return route.fulfill({ status: 503, json: {} });
  state.reads = (state.reads ?? 0) + 1;
  const body = { ...access, expectedSequence: state.posts ? 5 : 4 };
  if (state.scene === 'audience' || state.scene === 'saved' && state.posts) {
    body.grants = [grant, { ...grant, granteeKind: 'assistant', granteeId: 'helper',
      displayName: 'Sales assistant', source: 'assistant', membershipStatus: null,
      eventId: 'assistant-grant', sequence: state.posts ? 5 : 3 }];
  }
  if (state.scene === 'overflow') body.grants = [{ ...grant, displayName: 'A'.repeat(200) }];
  if (state.scene === 'empty') body.grants = [];
  body.grantTotal = body.grants.length;
  return route.fulfill({ json: body });
}
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const scenes = ['audience', 'loading', 'empty', 'overflow', 'outage', 'conflict', 'no-effect',
  'applying', 'content-applying', 'unknown', 'saved', 'cursor', 'refused401', 'refused403'];
try {
  for (const width of [1280, 390]) {
    for (const scene of scenes) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const state = { scene, posts: 0 };
      await page.route('**/*', serve.bind(null, state));
      await page.goto('https://tools-access.opencrane.test/org/integrations/fixture/tools');
      const editor = page.locator('oc-tool-audience');
      await editor.waitFor();
      if (['conflict', 'no-effect', 'applying', 'content-applying', 'unknown', 'saved'].includes(scene)) {
        await editor.getByRole('button', { name: 'Assistant', exact: true }).click();
        await editor.getByRole('button', { name: 'Sales assistant', exact: true }).focus();
        await page.keyboard.press('Enter');
        assert(await editor.getByRole('status').first().evaluate(hasFocus));
        await editor.getByRole('button', { name: 'Save access' }).click();
        const words = { conflict: 'Access changed.', 'no-effect': 'Nothing changed.',
          applying: 'Applying', 'content-applying': 'Applying', unknown: 'Outcome unknown.', saved: 'Saved.' };
        await editor.getByText(words[scene], { exact: false }).waitFor();
        if (['unknown', 'applying', 'content-applying'].includes(scene)) {
          assert(await page.getByRole('button', { name: 'Review access' }).isDisabled());
          assert(await page.locator('fieldset').isDisabled());
          await editor.getByRole('button', { name: 'Check status' }).click();
          await page.reload();
          await editor.getByRole('button', { name: 'Check status' }).waitFor();
        }
        if (scene === 'saved') {
          assert.equal(state.reads, 2);
          assert(await page.getByRole('button', { name: 'Review access' }).isEnabled());
          await editor.getByText('Sales assistant · Assistant', { exact: false }).waitFor();
        }
        assert.equal(state.posts, 1);
      } else if (scene === 'empty') {
        await editor.getByRole('button', { name: 'Person', exact: true }).click();
        await editor.getByText('No candidates found.').waitFor();
      } else if (scene === 'cursor' || scene.startsWith('refused')) {
        await editor.getByRole('button', { name: 'Person', exact: true }).click();
        if (scene === 'cursor') {
          assert(await editor.getByRole('button', { name: 'Alex Kim', exact: true }).isDisabled());
          await editor.getByRole('button', { name: 'Load more' }).click();
        }
        await editor.getByRole('button', { name: 'Assistant', exact: true }).click();
        if (scene === 'cursor') {
          await editor.getByRole('button', { name: 'Sales assistant' }).waitFor();
          await state.held.fulfill({ json: choices('member') });
          assert.equal(await editor.getByRole('button', { name: 'Alex Kim', exact: true }).count(), 0);
        }
        else {
          await page.getByRole('heading', { name: 'You no longer have access to Integrations' }).waitFor();
          await state.held.fulfill({ json: choices('member') });
          assert(!(await page.locator('main').innerText()).includes('Alex Kim'));
        }
      }
      await page.evaluate(waitForFonts);
      assert(await page.evaluate(pageHasNoOverflow));
      for (const button of await editor.locator('button:visible').all()) {
        const box = await button.boundingBox();
        assert(box && box.height >= 44 && box.width >= 44);
      }
      await page.screenshot({ path: resolve(output, `${scene}-${width}.png`), fullPage: true });
      await page.close();
    }
  }
} finally {
  await browser.close();
}
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const receipt = `# Initial tool audience

Date: ${time}. Source: ${source}.
Environment: built web app, intercepted APIs and a fresh browser context per case. No live install.
Command: \`npm run visual:screen-tools-access\`.

PASS: 28 captures at 1280/390, reduced motion, keyboard selection, focus, 44px audience controls and no overflow.
PASS: each save sends once and reads its original receipt. Content and IAM Applying both block review. Saved reads access again. Reload keeps the original status check. Conflict, no-effect, unknown, empty, outage, stale cursor and 401/403 clearing match the expected states.
[Desktop](audience-1280.png) and [phone](audience-390.png) show the saved audience.

PARTIAL: INT-31 uses existing chips and shared states. Tool rows and shell keep the earlier publication layout. The existing INT-33 page explains the pair. Published editing and groups are outside this part.
NOT RUN: fresh-install journey, real IAM or gateway, model calls and full root suite.
`;
await writeFile(resolve(output, 'receipt.md'), receipt);
