import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
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
async function prompt(page: Page, config: AuthConfig, user: User, value: 'login' | 'none', idToken?: string) {
  // Exercise two provider sessions in one cookie jar, without changing the registered app.
  await page.route(`${new URL(config.redirectUri).origin}/auth/login**`, async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const url = new URL(response.headers()['location']!);
    url.searchParams.set('prompt', value);
    url.searchParams.set('login_hint', user.login);
    if (idToken) url.searchParams.set('id_token_hint', idToken);
    await route.fulfill({ response, headers: { ...response.headers(), location: url.href } });
  }, { times: 1 });
}
async function login(page: Page, origin: string, user: User) {
  let step = 'home';
  try {
    await page.goto(origin);
    step = 'SSO button';
    await page.getByRole('button', { name: 'Continue with single sign-on', exact: true }).click();
    step = 'provider input';
    await page.locator('input[name=loginName]:visible, input[type=password]:visible').first().waitFor();
    if (await page.locator('input[name=loginName]').isVisible()) {
      step = 'username';
      await page.locator('input[name=loginName]').fill(user.login);
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
    }
    step = 'password';
    await page.locator('input[type=password]').waitFor();
    await page.locator('input[type=password]').fill(await readFile(user.passwordFile, 'utf8'));
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    step = 'return';
    await page.waitForURL((url) => url.origin === origin && !url.pathname.startsWith('/auth/'));
  } catch {
    throw new Error(`Login did not complete at ${step}`);
  }
}
async function cookie(context: BrowserContext, config: AuthConfig, origin: string) {
  const session = (await context.cookies(origin)).find((item) => item.name === config.cookieName);
  assert(session, 'Real login must issue a session');
  assert(session.secure && session.httpOnly && session.sameSite === 'Lax');
  return session.value;
}
export async function browserSessions(config: AuthConfig, origin: string) {
  const browser = await chromium.launch({ headless: true });
  let stage = 'launch';
  try {
    const users = await testUsers();
    const sessions = new Map<string, { sub: string; cookie: string }>();
    const idTokens = new Map<string, string>();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    for (const role of ['owner', 'member'] as const) {
      await context.clearCookies({ name: config.cookieName });
      await prompt(page, config, users[role], 'login');
      stage = `${role} login`;
      await login(page, origin, users[role]);
      stage = `${role} cookie`;
      await page.getByRole('heading', { name: 'You are signed in' }).waitFor();
      const value = await cookie(page.context(), config, origin);
      const session = decodeSession(config, value);
      assert.equal(session.sub, users[role].id);
      assert.equal(session.orgId, config.expectedOrgId);
      assert(session.idToken, 'Real login retains its ID token for logout');
      idTokens.set(role, session.idToken);
      sessions.set(role, { sub: session.sub, cookie: `${config.cookieName}=${value}` });
    }
    console.log('PASS sign-in: owner and member via Zitadel + PKCE over tailnet HTTPS at 390px in one browser');
    stage = 'logout CSRF';
    await logoutCsrfChecks(page, origin);
    stage = 'refusal checks';
    await refusalChecks(browser, config, origin, users.member);
    return { sessions, close: async () => {
      try {
        stage = 'member logout';
        await boundLogout(page, config, origin);
        stage = 'member ended';
        await silentLogin(page, config, origin, users.member, idTokens.get('member')!, false);
        stage = 'owner retained';
        await silentLogin(page, config, origin, users.owner, idTokens.get('owner')!, true);
        idTokens.set('owner', decodeSession(config, await cookie(context, config, origin)).idToken!);
        stage = 'owner logout';
        await boundLogout(page, config, origin);
        stage = 'owner ended';
        await silentLogin(page, config, origin, users.owner, idTokens.get('owner')!, false);
        console.log('PASS sign-out: two accounts in one browser; no chooser; member ended, owner retained, then owner ended');
      } catch { throw new Error(`Real browser logout failed at ${stage}`); }
      finally { await browser.close(); }
    } };
  } catch (error) {
    await browser.close();
    if (error instanceof Error && error.message.startsWith('Login did not complete at ')) throw error;
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
async function boundLogout(page: Page, config: AuthConfig, origin: string) {
  const idToken = decodeSession(config, await cookie(page.context(), config, origin)).idToken;
  const request = page.waitForRequest((request) => new URL(request.url()).origin === config.issuerUrl
    && new URL(request.url()).pathname === '/oidc/v1/end_session');
  const returned = page.waitForResponse((reply) => reply.request().isNavigationRequest() && reply.url() === origin + '/');
  const [logout] = await Promise.all([request, returned,
    page.getByRole('button', { name: 'Sign out', exact: true }).click()]);
  const params = new URL(logout.url()).searchParams;
  assert(idToken && params.get('id_token_hint') === idToken, 'Logout must bind the current provider session');
  assert.equal(params.get('client_id'), config.clientId);
  assert.equal(params.get('post_logout_redirect_uri'), config.postLogoutRedirectUri);
  // No account selection or provider interaction is allowed between click and return.
  await page.waitForURL(origin + '/');
  await page.getByRole('button', { name: 'Continue with single sign-on', exact: true }).waitFor();
  const me = z.object({ authenticated: z.boolean() }).parse(await (await page.request.get(`${origin}/auth/me`)).json());
  assert.equal(me.authenticated, false);
}
async function silentLogin(page: Page, config: AuthConfig, origin: string, user: User, idToken: string, succeeds: boolean) {
  await prompt(page, config, user, 'none', idToken);
  await page.goto(`${origin}/auth/login`);
  if (succeeds) {
    await page.waitForURL((url) => url.origin === origin && !url.pathname.startsWith('/auth/'));
  } else {
    // Login V2 #12165 may redirect in JavaScript to JSON, or present credentials.
    // Observe the final page, not page.goto's intermediate response.
    const noSession = page.locator('pre').filter({ hasText: 'No active session found' });
    const credentials = page.locator('input[name=loginName]:visible, input[type=password]:visible');
    await noSession.or(credentials).or(page.getByRole('heading', { name: 'Sign in to your workspace', exact: true }))
      .first().waitFor();
    if (new URL(page.url()).origin !== origin) {
      assert.equal(new URL(page.url()).origin, config.issuerUrl);
      if (await noSession.isVisible()) {
        z.object({ error: z.literal('No active session found') }).strict().parse(JSON.parse((await noSession.textContent())!));
      } else await credentials.first().waitFor();
    }
  }
  const me = z.object({ authenticated: z.boolean(), user: z.object({ sub: z.string() }).nullable() })
    .parse(await (await page.request.get(`${origin}/auth/me`)).json());
  assert.equal(me.authenticated, succeeds, 'Only the intended provider session must end');
  if (succeeds) {
    assert.equal(me.user?.sub, user.id);
    await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  }
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
