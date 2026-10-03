/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type BrowserContext, type Page, type Request as BrowserRequest } from 'playwright';
import { z } from 'zod';
import { decodeSession, type AuthConfig } from '@opencrane/auth';
import { buildServer } from '../../apps/server/src/server.ts';
import { directory } from './config.ts';

const userSchema = z.object({ id: z.string(), login: z.string(), passwordFile: z.string() });
const setupSchema = z.object({ users: z.object({ owner: userSchema, member: userSchema }) });
export async function testUsers() {
  return setupSchema.parse(JSON.parse(await readFile(`${directory}/zitadel.json`, 'utf8'))).users;
}
type User = z.infer<typeof userSchema>;
export async function enterLoginName(page: Page, name: string) {
  const field = page.locator('input[name=loginName]');
  for (let attempt = 0; attempt < 2; attempt++) {
    await field.fill(name);
    try {
      await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 5000 });
      return;
    } catch (error) {
      // The provider can replace an early-filled input while its page becomes interactive.
      if (attempt === 1 || !await field.isVisible() || await field.inputValue() !== '') throw error;
    }
  }
}
async function login(page: Page, origin: string, user: User, selectRememberedAccount = false) {
  let step = 'home', transport = '';
  const failed = (request: BrowserRequest) => {
    const code = request.failure()?.errorText ?? '';
    if (/^net::[A-Z_]+$/.test(code)) transport = code;
  };
  page.on('requestfailed', failed);
  try {
    await page.bringToFront();
    await page.goto(origin);
    step = 'SSO button';
    await page.getByRole('button', { name: 'Continue with single sign-on', exact: true }).click();
    step = 'provider input';
    const credentials = page.locator('input[name=loginName]:visible, input[type=password]:visible');
    if (selectRememberedAccount) {
      // Zitadel remembers the identity after ending its session; selection must still require a password.
      const account = page.getByRole('button').filter({ hasText: user.login });
      await credentials.or(account).first().waitFor();
      if (await account.isVisible()) await account.click();
    }
    await credentials.first().waitFor();
    if (await page.locator('input[name=loginName]').isVisible()) {
      step = 'username';
      await enterLoginName(page, user.login);
    }
    step = 'password';
    await page.locator('input[type=password]').waitFor();
    if (selectRememberedAccount) {
      const me = z.object({ authenticated: z.boolean() }).parse(await (await page.request.get(`${origin}/auth/me`)).json());
      assert.equal(me.authenticated, false, 'Remembered account selection must not create a session without credentials');
    }
    await page.locator('input[type=password]').fill(await readFile(user.passwordFile, 'utf8'));
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    step = 'return';
    await page.waitForURL((url) => url.origin === origin && !url.pathname.startsWith('/auth/'));
  } catch {
    await page.screenshot({ path: `${directory}/signin-failure.png` });
    const location = new URL(page.url());
    throw new Error(`Login did not complete at ${step} (${location.origin}${location.pathname}; ${transport})`);
  } finally { page.off('requestfailed', failed); }
}
async function cookie(context: BrowserContext, config: AuthConfig, origin: string) {
  const session = (await context.cookies(origin)).find((item) => item.name === config.cookieName);
  assert(session, 'Real login must issue a session');
  assert.equal(session.secure, config.cookieSecure);
  assert(session.httpOnly && session.sameSite === 'Lax');
  return session.value;
}
export async function browserSessions(config: AuthConfig, origin: string) {
  const browser = await chromium.launch({ headless: true });
  let stage = 'launch';
  try {
    const users = await testUsers();
    const sessions = new Map<string, { sub: string; cookie: string }>();
    let page: Page | undefined;
    const memberPages: Page[] = [];
    for (const [role, width] of [['owner', 390], ['member', 390], ['member', 1280]] as const) {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
      page = await context.newPage();
      page.setDefaultTimeout(30_000);
      stage = `${role} ${width}px login`;
      await login(page, origin, users[role]);
      stage = `${role} signed-in screen`;
      await page.getByRole('heading', { name: 'You are signed in' }).waitFor();
      stage = `${role} cookie`;
      const value = await cookie(page.context(), config, origin);
      stage = `${role} session decoding`;
      const session = decodeSession(config, value);
      stage = `${role} identity`;
      assert.equal(session.sub, users[role].id);
      assert.equal(session.orgId, config.expectedOrgId);
      assert(session.idToken, 'Real login retains its ID token for logout');
      if (role === 'member') memberPages.push(page);
      sessions.set(role, { sub: session.sub, cookie: `${config.cookieName}=${value}` });
    }
    console.log('PASS sign-in: owner and member via Zitadel + PKCE at the selected stack origin at 390px, and member at 1280px, in separate browser contexts');
    assert(page);
    const memberPage = page;
    stage = 'logout CSRF';
    await logoutCsrfChecks(page, origin);
    stage = 'refusal checks';
    await refusalChecks(browser, config, origin, users.member);
    return { sessions, memberPages, close: async () => {
      try {
        stage = 'token exposure probes';
        await tokenExposureChecks(browser, config, origin, users.member, (step) => { stage = step; });
        await memberPage.goto(origin);
        stage = 'form logout';
        await formLogout(memberPage, config, origin);
        stage = 'credentials after logout';
        await login(memberPage, origin, users.member, true);
        await memberPage.getByRole('heading', { name: 'You are signed in' }).waitFor();
        assert.equal(decodeSession(config, await cookie(memberPage.context(), config, origin)).sub, users.member.id);
        console.log('PASS next sign-in: remembered identity still requires credentials; successful reauthentication');
      } catch (error) {
        const detail = error instanceof Error && error.message.startsWith('Login did not complete at ') ? `: ${error.message}` : '';
        throw new Error(`Real browser logout failed at ${stage}${detail}`);
      }
      finally { await browser.close(); }
    } };
  } catch (error) {
    await browser.close();
    if (error instanceof Error && error.message.startsWith('Login did not complete at ')) throw new Error(`Real browser sign-in failed at ${stage}: ${error.message}`);
    throw new Error(`Real browser sign-in failed at ${stage}`);
  }
}
async function logoutCsrfChecks(page: Page, origin: string) {
  for (const headers of [{}, { origin: 'https://attacker.example' }]) {
    const response = await page.request.post(`${origin}/auth/logout`, { headers });
    assert.equal(response.status(), 403);
    assert.equal(response.headers()['set-cookie'], undefined);
    const me = z.object({ authenticated: z.boolean(), user: z.record(z.string(), z.unknown()) })
      .parse(await (await page.request.get(`${origin}/auth/me`)).json());
    assert.equal(me.authenticated, true);
    assert(!('idToken' in me.user), 'Session inspection must never expose the ID token');
  }
  console.log('PASS logout CSRF: hostile and missing Origin refused, real session retained, no token in /auth/me');
}
async function tokenExposureChecks(browser: Browser, config: AuthConfig, origin: string, user: User, stage: (step: string) => void) {
  for (const transport of ['response body', 'manual fetch', 'fetch', 'XHR'] as const) {
    // A followed fetch can change provider sessions even when CORS hides its response.
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      stage(`login for ${transport}`);
      await login(page, origin, user);
      await page.getByRole('heading', { name: 'You are signed in' }).waitFor();
      stage(`${transport} exposure`);
      const idToken = decodeSession(config, await cookie(context, config, origin)).idToken;
      assert(idToken);
      if (transport === 'response body') {
        const reply = await page.request.post(`${origin}/auth/logout`, { headers: { origin }, maxRedirects: 0 });
        assert.equal(reply.status(), 303);
        assert((await reply.body()).length === 0, 'Logout response body must be empty');
        assert(new URL(reply.headers()['location']!).searchParams.get('id_token_hint') === idToken);
        assert.equal(reply.headers()['cache-control'], 'no-store');
      } else {
        // Return only booleans. Never inject the real token into the page or record response data.
        const response = page.waitForResponse((reply) => reply.url() === origin + '/auth/logout');
        const exposed = await page.evaluate(async (transport) => {
          const containsToken = (value: string) => /eyJ[\w-]+\.[\w-]+\.[\w-]+/u.test(value) || value.includes('id_token_hint');
          if (transport === 'XHR') return await new Promise<boolean>((resolve) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/auth/logout');
            xhr.onloadend = () => resolve(containsToken(xhr.responseText + xhr.responseURL + xhr.getAllResponseHeaders()));
            xhr.send();
          });
          try {
            const reply = await fetch('/auth/logout', { method: 'POST', redirect: transport === 'manual fetch' ? 'manual' : 'follow' });
            return containsToken(await reply.text()) || containsToken(reply.url + JSON.stringify([...reply.headers]));
          } catch { return false; } // A cross-origin redirect is not readable without CORS permission.
        }, transport);
        assert.equal((await response).status(), 303);
        assert.equal(exposed, false, `${transport} must not expose the ID token`);
      }
      assert(!(await context.cookies(origin)).some((item) => item.name === config.cookieName));
      const domExposed = await page.evaluate(() => /eyJ[\w-]+\.[\w-]+\.[\w-]+/u.test(document.documentElement.outerHTML + document.cookie)
        || document.documentElement.outerHTML.includes('id_token_hint'));
      assert.equal(domExposed, false, 'DOM and page cookies must not expose the ID token');
      await checkLogs(idToken);
    } finally { await context.close(); }
  }
  console.log('PASS token boundary: empty 303 body; manual/follow fetch, XHR, DOM and page cookies expose no ID token');
}
async function checkLogs(idToken: string) {
  for (const name of ['server', 'web', 'members', 'mcp-catalogue', 'dispatcher']) {
    assert(!(await readFile(`${directory}/${name}.log`, 'utf8')).includes(idToken), 'Stack logs must not contain the ID token');
  }
}
async function formLogout(page: Page, config: AuthConfig, origin: string) {
  const idToken = decodeSession(config, await cookie(page.context(), config, origin)).idToken;
  const form = page.locator('form[action="/auth/logout"]');
  assert.equal(await form.getAttribute('method'), 'post');
  const request = page.waitForRequest((request) => new URL(request.url()).origin === config.issuerUrl
    && new URL(request.url()).pathname === '/oidc/v1/end_session');
  const response = page.waitForResponse((reply) => reply.url() === origin + '/auth/logout');
  let providerPageShown = false;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && new URL(frame.url()).origin !== origin) providerPageShown = true;
  });
  const button = form.getByRole('button', { name: 'Sign out', exact: true });
  await button.focus();
  const [logout, reply] = await Promise.all([request, response, button.press('Enter')]);
  assert.equal(reply.status(), 303);
  assert.equal(reply.request().method(), 'POST');
  assert(reply.request().isNavigationRequest() && logout.isNavigationRequest());
  assert.equal(reply.request().frame(), page.mainFrame());
  const params = new URL(logout.url()).searchParams;
  assert(idToken && params.get('id_token_hint') === idToken, 'Logout must carry the current ID token');
  assert.equal(params.get('client_id'), config.clientId);
  assert.equal(params.get('post_logout_redirect_uri'), config.postLogoutRedirectUri);
  // No provider interaction is allowed between keyboard activation and return.
  await page.waitForURL(origin + '/');
  await page.getByRole('button', { name: 'Continue with single sign-on', exact: true }).waitFor();
  assert.equal(providerPageShown, false, 'Logout must not display a provider page or account chooser');
  assert(!(await page.context().cookies(origin)).some((item) => item.name === config.cookieName));
  const me = z.object({ authenticated: z.boolean() }).parse(await (await page.request.get(`${origin}/auth/me`)).json());
  assert.equal(me.authenticated, false);
  const refused = await page.request.post(`${origin}/auth/logout`, { headers: { origin }, maxRedirects: 0 });
  assert.equal(refused.status(), 401);
  assert.equal(refused.headers()['set-cookie'], undefined);
  assert(idToken);
  await checkLogs(idToken);
  console.log('PASS logs: no ID token in the five stack process logs');
  console.log('PASS form sign-out: top-level POST → 303 → Zitadel → home; no chooser, no session cookie; no-session POST refused');
}
async function refusalChecks(browser: Browser, config: AuthConfig, origin: string, user: User) {
  // A second real server varies only the pin / lifetime. No other Zitadel org is accessed.
  for (const check of ['organisation', 'expiry'] as const) {
    const probe = buildServer({ ...config, ...(check === 'organisation'
      ? { expectedOrgId: 'deliberately-wrong-org' } : { sessionMaxAgeSeconds: 2 }) }, { logDestination: { write: () => true } });
    const address = await probe.listen({ host: '127.0.0.1', port: 0 });
    const context = await browser.newContext();
    try {
      await context.route(`${origin}/auth/**`, async (route) => {
        const url = new URL(route.request().url());
        const response = await route.fetch({ url: `${address}${url.pathname}${url.search}`, maxRedirects: 0 });
        await route.fulfill({ response });
      });
      const page = await context.newPage();
      await login(page, origin, user);
      if (check === 'organisation') {
        assert.equal(new URL(page.url()).searchParams.get('reason'), 'organisation');
        await page.getByText('Those details did not sign you in', { exact: true }).waitFor();
        assert(!(await context.cookies(origin)).some((item) => item.name === config.cookieName));
        console.log('PASS wrong organisation: real Zitadel token refused by a different server org pin; no session');
      } else {
        const value = await cookie(context, config, origin);
        await delay(2100);
        // Replay the authentic expired cookie even after the browser drops it.
        const headers = { cookie: `${config.cookieName}=${value}` };
        const me = z.object({ authenticated: z.boolean() }).parse(await (await fetch(`${address}/auth/me`, { headers })).json());
        assert.equal(me.authenticated, false);
        assert.equal((await fetch(`${address}/api/org/integrations`, { headers })).status, 401);
        console.log('PASS expired session: real two-second login cookie refused by session and protected API routes');
      }
    } finally { await context.close(); await probe.close(); }
  }
}
