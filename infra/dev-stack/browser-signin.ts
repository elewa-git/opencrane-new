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
async function login(page: Page, origin: string, user: User) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Continue with single sign-on', exact: true }).click();
  await page.locator('input[name=loginName]').fill(user.login);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.locator('input[type=password]').waitFor();
  await page.locator('input[type=password]').fill(await readFile(user.passwordFile, 'utf8'));
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForURL((url) => url.origin === origin && !url.pathname.startsWith('/auth/'));
}
async function cookie(context: BrowserContext, config: AuthConfig, origin: string) {
  const session = (await context.cookies(origin)).find((item) => item.name === config.cookieName);
  assert(session, 'Real login must issue a session');
  assert(session.secure && session.httpOnly && session.sameSite === 'Lax');
  return session.value;
}
export async function browserSessions(config: AuthConfig, origin: string) {
  const browser = await chromium.launch({ headless: true });
  try {
    const users = await testUsers();
    const sessions = new Map<string, { sub: string; cookie: string }>();
    const pages: Page[] = [];
    for (const role of ['owner', 'member'] as const) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.setDefaultTimeout(30_000);
      pages.push(page);
      await login(page, origin, users[role]);
      await page.getByRole('heading', { name: 'You are signed in' }).waitFor();
      const value = await cookie(page.context(), config, origin);
      const session = decodeSession(config, value);
      assert.equal(session.sub, users[role].id);
      assert.equal(session.orgId, config.expectedOrgId);
      sessions.set(role, { sub: session.sub, cookie: `${config.cookieName}=${value}` });
    }
    console.log('PASS sign-in: owner and member via Zitadel + PKCE over tailnet HTTPS at 390px');
    await refusalChecks(browser, config, origin, users.member);
    return { sessions, close: async () => {
      try {
        for (const page of pages) {
          const providerLogout = page.waitForResponse((response) => new URL(response.url()).origin === config.issuerUrl
            && new URL(response.url()).pathname.includes('end_session'));
          await page.getByRole('button', { name: 'Sign out', exact: true }).click();
          await providerLogout;
          // Zitadel asks which account to end because we do not retain ID tokens.
          await page.getByText('Click an account to end the session', { exact: true }).waitFor();
          await page.getByText(/^OpenCrane (Owner|Member)$/u).click();
          await page.getByRole('button', { name: 'Continue with single sign-on', exact: true }).waitFor();
          const me = z.object({ authenticated: z.boolean() }).parse(await (await page.request.get(`${origin}/auth/me`)).json());
          assert.equal(me.authenticated, false);
          await page.getByRole('button', { name: 'Continue with single sign-on', exact: true }).click();
          await page.locator('input[name=loginName]').waitFor();
        }
        console.log('PASS sign-out: endSessionUrl returns home, local session cleared, provider requires login again');
      } catch { throw new Error('Real browser logout failed'); }
      finally { await browser.close(); }
    } };
  } catch {
    await browser.close();
    throw new Error('Real browser sign-in or refusal check failed');
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
