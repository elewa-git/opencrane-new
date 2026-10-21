/* global document */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-tools-publish');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://tools-publish.opencrane.test';
const checkedAt = new Date().toISOString();
const expiresAt = new Date(Date.parse(checkedAt) + 300_000).toISOString();
const review = { action: 'Read items', consequence: 'Items are read',
  targetArgument: 'item', fields: ['item'], stepUp: false };
const tool = { name: 'read_item_with_a_long_saved_name', revision: 'a'.repeat(64),
  reviewed: false, readOnly: true, mode: 'block', suggestion: 'allow', costCents: 0 };
const declaration = { name: tool.name, revision: tool.revision, reviewed: false,
  costCents: 0, review, definition: JSON.stringify({ name: tool.name,
  description: '<img src=x onerror=alert(1)>', inputSchema: { type: 'object' },
  _meta: { 'io.opencrane/costCents': 0, 'io.opencrane/review': review } }) };
const initial = { silo: 'test', serverId: 'fixture', sequence: 3, policyRevision: 2,
  connectionId: 'connection', accountMode: 'none', published: false, checkedAt, expiresAt,
  catalogue: { serverId: 'fixture', toolCount: 1, schemaDigest: 'b'.repeat(64),
    checkedAt, expiresAt, tools: [declaration] }, tools: [tool] };
const integration = { serverId: 'fixture', name: 'Fixture server', version: '1',
  accountModel: 'None', toolsAllowed: 0, toolsTotal: 1,
  source: { kind: 'remote_url', label: 'Remote URL', detail: 'example.test' },
  status: { kind: 'draft', label: 'Draft', detail: 'Review tools' } };
const access = { serverId: 'fixture', complete: true,
  projection: { content: 'current', iam: 'current' }, grants: [
    { granteeKind: 'member', granteeId: 'alex', displayName: 'Alex Kim', source: 'direct',
      state: 'granted', eventId: 'grant-person', eventTime: checkedAt, sequence: 1,
      projection: 'current', iam: 'current', membershipStatus: 'joined' },
    { granteeKind: 'assistant', granteeId: 'sales', displayName: 'Sales assistant',
      source: 'assistant', state: 'granted', eventId: 'grant-assistant', eventTime: checkedAt,
      sequence: 2, projection: 'current', iam: 'current', membershipStatus: null },
  ] };

async function serve(route, state) {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if (path === '/auth/me') {
    return route.fulfill({ json: { authenticated: true,
      user: { email: 'owner@example.test', role: 'Owner' } } });
  }
  if (!path.startsWith('/api/')) return serveWebBuild(route, build);
  if (request.method() === 'POST') {
    state.posts += 1;
    const command = request.postDataJSON();
    if (path.endsWith('/review')) {
      assert.equal(command.catalogueDigest, initial.catalogue.schemaDigest);
      assert.equal(command.connectionId, 'connection');
      assert.equal(command.accountMode, 'none');
      assert.equal(command.policyRevision, 2);
      assert.equal(command.tools[0].mode, 'allow');
      assert.match(command.tools[0].reviewDigest, /^[a-f0-9]{64}$/u);
      if (state.scenario === 'lost-review') {
        state.reference = command.commandId;
        return route.abort();
      }
      if (state.scenario === 'conflict') return route.fulfill({ status: 409, json: {} });
      return route.fulfill({ json: { status: 'appended', sequence: 4 } });
    }
    assert(path.endsWith('/publication'));
    assert.equal(command.reviewRevision, 4);
    assert.equal(command.expectedSequence, 4);
    state.reference = command.commandId;
    state.policy = { ...initial, sequence: 5, policyRevision: 5,
      publicationRevision: 5, reviewRevision: 4,
      tools: [{ ...tool, reviewed: true, mode: 'allow' }],
      publication: { serverId: 'fixture', publishedBy: 'owner', ...command,
        fragmentDigest: 'f'.repeat(64) } };
    if (state.ack) state.policy.sequence = 6;
    if (state.ack) state.policy.configurationObservation = {
      serverId: 'fixture', changeRef: command.commandId, sourceSequence: 5,
      reviewRevision: 4, generation: 1, fragmentDigest: 'f'.repeat(64),
      recordDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64),
      processRef: '00000000-0000-4000-8000-000000000001', observedAt: checkedAt,
    };
    if (state.scenario === 'lost') return route.abort();
    return route.fulfill({ json: { status: 'appended', sequence: 5 } });
  }
  let body;
  if (path === '/api/org/integrations') body = { rows: [integration], loadedAt: checkedAt };
  else if (path.endsWith('/tools')) {
    if (state.scenario === 'loading') return;
    body = state.policy;
  }
  else if (path.endsWith('/access')) {
    if (state.scenario === 'refusal') return route.fulfill({ status: 403, json: {} });
    body = access;
  } else if (path.endsWith('/facts')) return route.fulfill({ status: 404, json: {} });
  else if (path.endsWith('/publication')) body = { status: 'disabled' };
  else if (path.includes('/changes/')) {
    body = { status: 'applying', changeRef: state.reference };
    if (['lost', 'lost-review'].includes(state.scenario)) body.status = 'unknown';
    if (state.ack) body = { status: 'ready', changeRef: state.reference, generation: 1,
      fragmentDigest: 'f'.repeat(64), recordDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64),
      requestedAt: checkedAt, observedAt: checkedAt };
    if (state.scenario === 'malformed') body = { status: 'ready', changeRef: state.reference };
    if (state.scenario === 'wrong-config') body.configDigest = 'e'.repeat(64);
    if (state.scenario === 'stale') body.fragmentDigest = 'e'.repeat(64);
    if (state.scenario === 'wrong') body.changeRef = 'another-change';
  } else throw new Error(`Unexpected API path ${path}`);
  return route.fulfill({ json: body });
}

function containsFocus(panel) {
  return panel.contains(document.activeElement);
}
function hasFocus(element) {
  return element === document.activeElement;
}

async function layout(page) {
  await page.evaluate(waitForFonts);
  assert(await page.evaluate(pageHasNoOverflow));
  for (const button of await page.locator('main button:visible, main summary:visible').all()) {
    const box = await button.boundingBox();
    assert(box && box.height >= 44, 'Control shorter than 44 px');
  }
}

async function assertFrameState(page, width, scenario) {
  if (scenario === 'tools' && width === 390) {
    const action = await page.getByRole('button', { name: 'Review before publishing' }).boundingBox();
    const panel = await page.locator('.tool-policy').boundingBox();
    assert(action && panel && action.width >= panel.width - 2, 'Phone review action must fill the panel');
  }
  if (scenario === 'confirm' && width === 390) {
    const actions = await page.locator('dialog .actions').boundingBox();
    assert(actions && actions.y + actions.height >= 870, 'Phone confirmation actions must sit at the bottom');
  }
  if (['applying', 'ready', 'lost', 'lost-review', 'malformed', 'stale', 'wrong',
    'wrong-config', 'conflict'].includes(scenario)) {
    assert.equal(await page.locator('.changes-list, oc-initial-review-confirmation').count(), 0,
      'Publication outcomes must hide the review form');
  }
  if (scenario === 'applying') {
    assert.equal(await page.locator('h1').innerText(), 'Publishing Fixture server');
  }
  if (scenario === 'ready') {
    assert.equal(await page.locator('.publication-notice [data-glyph-name="check"]').count(), 1);
    assert.equal(await page.locator('main').getByText(/Calls stay paused/).count(), 0);
    assert.equal(await page.locator('.status-glyph').count(), 0);
  }
  if (['lost', 'lost-review', 'malformed', 'stale', 'wrong', 'wrong-config'].includes(scenario)) {
    assert.equal(await page.locator('.publication-notice [data-state="unknown"]').count(), 1);
    const action = await page.getByRole('button', { name: 'Check status' }).boundingBox();
    assert(action && action.y < 500, 'Check status must stay near the top');
  }
  if (scenario === 'conflict') {
    assert.equal(await page.locator('.draft-notice.publication-conflict').count(), 1);
    assert.equal(await page.getByRole('link', { name: 'Discard my edits' }).count(), 1);
  }
  if (scenario === 'refusal') {
    assert.equal(await page.getByRole('link', { name: 'Go to Overview' }).getAttribute('href'), '/org/overview');
    assert.equal(await page.locator('main').getByText('Your access has changed. Details have been cleared from this page.').count(), 1);
  }
}

async function capture(browser, width, scenario) {
  const state = { scenario, policy: structuredClone(initial), posts: 0,
    ack: ['ready', 'stale', 'wrong', 'wrong-config'].includes(scenario) };
  if (scenario === 'empty') state.policy.tools = [];
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  async function intercept(route) { await serve(route, state); }
  await page.route('**/*', intercept);
  await page.goto(`${origin}/org/integrations/fixture/tools`);
  const confirmedStatus = page.locator('.publication-notice').filter({
    hasText: 'The current publication is confirmed.',
  });
  if (scenario === 'loading') await page.getByText('Loading tools…', { exact: true }).waitFor();
  else if (scenario === 'empty') await page.getByText('No tool list has been read yet.').waitFor();
  else {
    await page.locator('fieldset').waitFor();
    assert(await page.locator('input[value="block"]').isChecked());
    if (scenario !== 'tools') {
      await page.locator('input[value="allow"]').locator('..').click();
      await page.getByRole('button', { name: 'Review before publishing' }).click();
      if (scenario === 'refusal') await page.getByText('You no longer have access to Integrations').waitFor();
      else {
        await page.getByText('Saved audience. Publishing does not change these grants.').waitFor();
        assert.equal(await page.locator('main img').count(), 0);
        if (scenario !== 'review') {
          const opener = page.getByRole('button', { name: 'Publish reviewed tools' });
          await opener.click();
          const confirm = page.getByRole('button', { name: 'Confirm publication' });
          assert(await confirm.isDisabled());
          await page.getByRole('checkbox').check();
          await confirm.focus();
          await page.keyboard.press('Tab');
          assert(await page.locator('dialog[open]').evaluate(containsFocus));
          await page.keyboard.press('Shift+Tab');
          assert(await confirm.evaluate(hasFocus));
          if (scenario === 'confirm') {
            await page.keyboard.press('Escape');
            await opener.waitFor();
            assert(await opener.evaluate(hasFocus));
            await opener.click();
            assert(await confirm.isDisabled());
          } else {
            await confirm.click();
            if (scenario === 'conflict') await page.getByText('The tool list changed.').waitFor();
            else if (scenario === 'ready') await confirmedStatus.waitFor();
            else {
              await page.getByRole('button', { name: 'Check status' }).waitFor();
              if (['applying', 'lost', 'lost-review'].includes(scenario)) {
                await page.reload();
                await page.getByRole('button', { name: 'Check status' }).waitFor();
                assert.equal(state.posts, scenario === 'lost-review' ? 1 : 2);
              }
              assert.equal(await confirmedStatus.count(), 0);
            }
          }
        }
      }
    }
  }
  await layout(page);
  await assertFrameState(page, width, scenario);
  await page.screenshot({ path: resolve(output, `${scenario}-${width}.png`), fullPage: scenario !== 'confirm' });
  await page.close();
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const failures = [];
try {
  for (const width of [1280, 390]) {
    for (const scenario of ['wrong-config', 'lost-review', 'tools', 'review', 'confirm', 'applying', 'lost', 'conflict',
      'refusal', 'empty', 'loading', 'ready', 'malformed', 'stale', 'wrong']) {
      try {
        await capture(browser, width, scenario);
      } catch (error) {
        failures.push(`${scenario}-${width}: ${error.message}`);
        for (const context of browser.contexts()) await context.close();
      }
    }
  }
} finally { await browser.close(); }
assert.deepEqual(failures, [], 'Screen checks failed');
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
await writeFile(resolve(output, 'receipt.md'), '# Initial tool publication screens\n\n' +
  `Date: ${checkedAt}. Source base: ${source}, plus working-tree changes.\n\n` +
  'PASS: intercepted browser checks at 1280 and 390 px, reduced motion, modal focus, ' +
  '44 px controls and no horizontal overflow. Applying and lost replies survive reload; ' +
  'only the original change is checked. Malformed, stale and wrong-reference replies stay unknown.\n\n' +
  'Frames: INT-30 tools, INT-34 review, INT-35 confirmation and INT-36 publication. ' +
  'Conflict, refusal and uncertain results reuse the existing recovery states.\n\n' +
  'PARTIAL: existing definition and publication status UI is reused. Expanded publication ' +
  'and apply details await frames. The integration facts route is absent on this base.\n\n' +
  'NOT RUN: fresh-install journey, real gateway acknowledgement or paid calls.\n');
