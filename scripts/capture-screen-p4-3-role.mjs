import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-p4-3-role');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://screen-p4-3-role.opencrane.test';
// Show the sample page to an Owner signed in as jente@elewa.ke.
const member = { memberId: 'alex-kim', displayName: 'Alex Kim', role: 'member',
  permissions: { changeRole: true, remove: true, manageOwnership: true },
  email: 'alex@example.test', status: 'joined', joinedAt: '2026-03-12T10:00:00Z',
  groups: [], memberSequence: 2, ownershipSequence: 1,
  personalAssistant: { status: 'unavailable' }, rejoinedAt: { status: 'unavailable' } };
const receipt = { status: 'recorded', commandId: 'role-command', changeId: 'change-1',
  type: 'member.role_changed', sequence: 3, recordedAt: '2026-10-18T10:00:00Z',
  memberId: 'alex-kim', newRole: 'admin' };

function shownRole(state) {
  if (state.frame === 'owner-target') return 'owner';
  if (state.frame === 'confirmed' && state.memberReads > 1) return 'admin';
  return 'member';
}

async function serve(state, route) {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/members/alex-kim') {
    state.memberReads += 1;
    if (state.frame === 'access-lost' && state.memberReads > 1) {
      await route.fulfill({ status: 403, body: '' });
      return;
    }
    if (state.frame === 'read-only') {
      const header = { memberId: member.memberId, displayName: member.displayName,
        role: 'member', permissions: { changeRole: false, remove: false,
          manageOwnership: false } };
      await route.fulfill({ json: header });
      return;
    }
    const role = shownRole(state);
    const permissions = role === 'owner' ? { ...member.permissions, changeRole: false } :
      member.permissions;
    await route.fulfill({ json: { ...member, role, permissions } });
    return;
  }
  if (url.pathname === '/api/members/alex-kim/access') {
    await route.fulfill({ json: { checkedAt: '2026-10-18T10:00:00Z',
      complete: true, unavailableSections: [], rows: [] } });
    return;
  }
  if (url.pathname === '/api/members/alex-kim/role') {
    const body = route.request().postDataJSON();
    state.commandId = body.commandId;
    if (state.frame === 'access-lost') {
      await route.fulfill({ status: 403, body: '' });
    } else if (state.frame === 'unknown') {
      await route.fulfill({ status: 503, body: '' });
    } else {
      await route.fulfill({ json: { ...receipt, commandId: state.commandId } });
    }
    return;
  }
  if (url.pathname.startsWith('/api/members/alex-kim/changes/')) {
    assert(url.pathname.endsWith(`/${state.commandId}`), 'Status reads the original request');
    const current = state.frame === 'confirmed' || state.frame === 'access-lost';
    const projection = { content: current ? 'current' : 'applying',
      iam: current ? 'current' : 'applying' };
    await route.fulfill({ json: { ...receipt, commandId: state.commandId,
      effect: 'role_changed', projection } });
    return;
  }
  if (url.pathname.startsWith('/api/')) assert.fail('Unexpected API request');
  await serveWebBuild(route, build);
}

function expectedOutcome(frame) {
  if (frame === 'access-lost') {
    return "You no longer have access to this person's details";
  }
  if (frame === 'confirmed') return 'Alex Kim is now an Admin';
  if (frame === 'applying') return 'Role change saved. Access is still updating.';
  return "We couldn't tell whether the role change was saved.";
}

async function capture(browser, width, frame) {
  const context = await browser.newContext({ viewport: { width, height: 900 },
    reducedMotion: 'reduce' });
  const page = await context.newPage();
  const state = { frame, memberReads: 0 };
  await page.route('**/*', route => serve(state, route));
  try {
    await page.goto(`${origin}/org/people/members/alex-kim`);
    await page.getByRole('heading', { name: 'Alex Kim', exact: true }).waitFor();
    if (frame === 'review') {
      const opener = page.getByRole('button', { name: 'Change role' });
      await opener.click();
      await page.getByRole('heading', { name: /Change Alex Kim.*role/ }).waitFor();
      await page.getByRole('button', { name: 'Cancel' }).last().click();
      assert(await opener.evaluate(element => element === globalThis.document.activeElement));
      await opener.click();
      await page.locator('input[value="admin"]').check();
    }
    if (['applying', 'confirmed', 'unknown', 'access-lost'].includes(frame)) {
      await page.getByRole('button', { name: 'Change role' }).click();
      await page.locator('input[value="admin"]').check();
      await page.getByRole('button', { name: 'Make Alex Kim an Admin' }).click();
      const text = expectedOutcome(frame);
      await page.getByText(text).first().waitFor();
    }
    if (frame === 'unknown') {
      assert.equal(await page.locator('main .member-role-status').count(), 0,
        'The open review contains the only unknown notice');
      assert(await page.locator('main .member-actions button.destructive').isDisabled(),
        'Removal stays blocked while the role outcome is unknown');
    }
    if (frame === 'read-only') {
      await page.getByText('Changing roles needs the Admin role').waitFor();
    }
    if (frame === 'owner-target') {
      await page.getByText('Owners are managed on the').waitFor();
    }
    await page.evaluate(waitForFonts);
    assert(await page.evaluate(pageHasNoOverflow), `No overflow at ${width}px in ${frame}`);
    const small = await page.locator('main button:visible, main a:visible, oc-modal-sheet button:visible, oc-modal-sheet label:visible')
      .evaluateAll(controls => controls.filter(control => {
        const bounds = control.getBoundingClientRect();
        return Math.round(bounds.width) < 44 || Math.round(bounds.height) < 44;
      }).map(control => control.tagName));
    assert.deepEqual(small, [], `44px targets at ${width}px in ${frame}`);
    const filename = `${frame}-${width}.png`;
    await page.screenshot({ path: resolve(output, filename), fullPage: true });
    return filename;
  } finally { await context.close(); }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const captures = [];
try {
  for (const width of [1280, 390]) {
    for (const frame of ['review', 'read-only', 'owner-target', 'applying', 'confirmed',
      'unknown', 'access-lost']) {
      captures.push(await capture(browser, width, frame));
    }
  }
} finally { await browser.close(); }
const note = '# Role screen captures\n\nPASS: Captured review, read-only, Owner target, applying, '
  + 'confirmed, unknown and access-lost views at 1280px and 390px with intercepted API replies. '
  + 'Checked reduced motion, no horizontal overflow, 44px actions and focus return after Cancel.\n\n'
  + 'Adaptations: Owner choices link to the existing Owners page. A read-only member '
  + 'gets the minimal server header, so email and access rows do not appear. '
  + 'The desktop modal is wider. The square radio choices have no selected card colour; '
  + 'they include Current and short role details. The modal footer order and stacked phone '
  + 'actions follow the shared sheet. Read-only views add Refresh and use the shared spacing '
  + 'and a white notice without a lock icon. Owner targets show detail cards and an Owners '
  + 'link in place of an ownership form. The shell does not have the account footer shown '
  + 'in the reference. Applying and confirmed outcomes use blue status cards. '
  + 'The unknown state keeps one notice in the open review.\n\n'
  + 'PARTIAL: These are sample screens. No live server or fresh-install journey was run.\n';
await writeFile(resolve(output, 'receipt.md'), note);
console.log(`Captured ${captures.length} role views`);
