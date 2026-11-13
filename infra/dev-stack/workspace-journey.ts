import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Page, Request } from 'playwright';
import { encodeSession } from '../../libs/auth/src/session.ts';
import { loadAuthConfig } from '../../libs/auth/src/config.ts';
import { browserSessions } from './browser-signin.ts';
import { authEnv, directory, readEnv, root } from './config.ts';
import { prepareOwnershipJourney } from './ownership-fixture.ts';
import { requireAutomatedJourney, requireStandInJourney } from './journey-guard.ts';
import { requireStageBStack } from './stage-b-guard.ts';

requireAutomatedJourney();
const claimedId = process.env['DEV_STACK_ID'];
assert(claimedId);
await requireStageBStack(claimedId, claimedId, homedir(), root);
const evidenceDirectory = resolve(root, 'docs/process/work-pilot-1045-s1/screenshots');
await mkdir(evidenceDirectory, { recursive: true });
const settings = await readEnv('settings');
requireStandInJourney(settings);
const origin = settings['ORIGIN'];
assert(origin);
const config = loadAuthConfig(await authEnv());
const sessions = await browserSessions(config, origin);
const browser = sessions.browser;
const memberPhone = sessions.memberPages[0];
const memberDesktop = sessions.memberPages[1];
const adminPage = sessions.ownerPage;
assert(memberPhone && memberDesktop);

async function goToWorkspace(page: Page, width: number) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.goto(`${origin}/workspace`);
  await page.locator('oc-workspace').waitFor();
  await page.waitForLoadState('networkidle');
}

async function openPhoneNavigation(page: Page) {
  const opener = page.getByRole('button', { name: 'Open session navigation' });
  if (await opener.isVisible()) await opener.click();
  await page.locator('oc-navigation-menu').waitFor();
  const menu = page.locator('oc-navigation-menu');
  const signOut = menu.getByRole('button', { name: 'Sign out', exact: true });
  await signOut.waitFor();
}

async function checkMember(width: number, page: Page) {
  await goToWorkspace(page, width);
  if (width === 390) await openPhoneNavigation(page);
  assert.equal(await page.locator('a[href="/org/integrations"]').count(), 0,
    `member must not see Settings at ${width}px`);
  await capture(page, `member-workspace-${width}`);
  await page.goto(`${origin}/org/integrations`);
  await page.getByRole('heading', { name: 'You no longer have access to Integrations' }).waitFor();
  assert.match(await page.locator('oc-integrations-access-lost').innerText(),
    /Owner or Admin role is needed/u);
  await capture(page, `member-refusal-${width}`);
  console.log(`PASS member ${width}px: no Settings link; visible Integrations refusal`);
}

async function checkSettings(page: Page, role: 'Admin' | 'Owner', width: number) {
  await goToWorkspace(page, width);
  const response = await page.request.get(`${origin}/api/chat`);
  assert.equal(response.status(), 200);
  const context = await response.json() as { role: string };
  assert.equal(context.role, role.toLowerCase());
  if (width === 390) await openPhoneNavigation(page);
  const navigation = page.locator(width === 390 ? 'oc-navigation-menu' : 'nav.rail');
  const settingsLink = navigation.getByRole('link', { name: 'Settings', exact: true });
  await settingsLink.waitFor();
  await settingsLink.click();
  await page.getByRole('heading', { name: 'Integrations', exact: true }).waitFor();
  assert.equal(await page.locator('oc-integrations-access-lost').count(), 0,
    `${role} must open Settings at ${width}px`);
  await capture(page, `${role.toLowerCase()}-settings-${width}`);
  console.log(`PASS ${role} ${width}px: Settings visible and opens`);
}

async function checkSignOut(page: Page, width: number, menu: boolean) {
  await goToWorkspace(page, width);
  if (menu) await openPhoneNavigation(page);
  const navigation = page.locator(menu ? 'oc-navigation-menu' : 'nav.rail');
  const signOut = navigation.getByRole('button', { name: 'Sign out', exact: true });
  await signOut.waitFor();
  const logout = page.waitForRequest(isLogoutPost);
  await signOut.click();
  const request = await logout;
  assert(request.isNavigationRequest());
  assert.match(request.headers()['content-type'] ?? '', /^text\/plain/u);
  await page.waitForURL(`${origin}/`);
  await page.getByRole('button', { name: 'Continue with single sign-on', exact: true }).waitFor();
  const state = await page.request.get(`${origin}/auth/me`);
  assert.equal(state.status(), 200);
  assert.equal((await state.json() as { authenticated: boolean }).authenticated, false);
  await capture(page, `member-signed-out-${width}`);
  console.log(`PASS member ${width}px: native Sign out reaches sign-in`);
}

async function capture(page: Page, name: string) {
  const privateFields = page.locator('input[type=email], input[type=password]');
  const emailText = page.getByText(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu);
  const mask = [privateFields, emailText];
  await page.screenshot({ path: `${evidenceDirectory}/${name}.png`, fullPage: true, mask });
}

function isLogoutPost(request: Request) {
  return new URL(request.url()).pathname === '/auth/logout' && request.method() === 'POST';
}

try {
  await checkMember(1280, memberDesktop);
  await checkMember(390, memberPhone);

  await checkSettings(adminPage, 'Admin', 1280);
  await checkSettings(adminPage, 'Admin', 390);

  const setup = JSON.parse(await readFile(`${directory}/zitadel.json`, 'utf8')) as {
    extraIdentities: Array<{ subject: string }>;
  };
  const separateOwner = setup.extraIdentities[0];
  assert(separateOwner);
  const now = Math.floor(Date.now() / 1000);
  const cookie = `${config.cookieName}=${encodeSession(config, {
    sub: separateOwner.subject, orgId: config.expectedOrgId!, roles: [], authTime: now, exp: now + 300,
  })}`;
  const fixtureContext = await browser.newContext({ extraHTTPHeaders: { cookie } });
  try {
    await prepareOwnershipJourney(fixtureContext.request, adminPage.request, origin);
    await checkSettings(adminPage, 'Owner', 1280);
    await checkSettings(adminPage, 'Owner', 390);
  } finally {
    await fixtureContext.close();
  }

  await checkSignOut(memberDesktop, 1280, false);
  await checkOwnerSignedIn();
  await checkSignOut(memberPhone, 390, true);
  await checkOwnerSignedIn();
  console.log('PASS #1045 slice journey at 1280px and 390px with screenshots');
} finally {
  await browser.close();
}

async function checkOwnerSignedIn() {
  const response = await adminPage.request.get(`${origin}/auth/me`);
  assert.equal(response.status(), 200);
  const state = await response.json() as { authenticated: boolean };
  assert.equal(state.authenticated, true);
  await adminPage.reload();
  await adminPage.getByRole('heading', { name: 'Integrations', exact: true }).waitFor();
  console.log('PASS separate owner browser remains signed in');
}
