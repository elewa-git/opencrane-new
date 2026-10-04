import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { encodeSession } from '@opencrane/auth';
import { natsFixture } from '@opencrane/event-store/testing';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

it('claims through the browser at 1280 and 390px using keyboard input and clears the token', async () => {
  const directory = await mkdtemp(`${tmpdir()}/bootstrap-browser-`);
  const path = `${directory}/token.json`;
  const generated = spawnSync(process.execPath, ['--experimental-strip-types', resolve('apps/server/src/bootstrap-token.ts')], {
    env: { ...process.env, BOOTSTRAP_TOKEN_FILE: path, SILO_ID: 'test' }, encoding: 'utf8',
  });
  expect(generated.status, generated.stderr).toBe(0);
  const token = generated.stdout.trim();
  process.env['BOOTSTRAP_TOKEN_FILE'] = path;
  const nats = await natsFixture(), config = testAuthConfig({ expectedOrgId: 'org-acme', cookieSecure: false });
  const app = buildServer(config, { membership: { silo: 'test', store: nats.store } });
  delete process.env['BOOTSTRAP_TOKEN_FILE'];
  const target = await app.listen({ host: '127.0.0.1', port: 0 });
  const proxy = `${directory}/proxy.json`;
  await writeFile(proxy, JSON.stringify({ '/api': { target }, '/auth': { target } }));
  const web = spawn(process.execPath, ['--experimental-strip-types', '--import', resolve('apps/server/test/support/ephemeral-ports.ts'),
    resolve('node_modules/@angular/cli/bin/ng.js'), 'serve', '--prebundle=false', '--host', '127.0.0.1', '--port', '0', '--proxy-config', proxy],
    { cwd: resolve('apps/web'), env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  web.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  web.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exited = once(web, 'exit'), browser = await chromium.launch({ headless: true });
  try {
    let base = '';
    await vi.waitFor(async () => {
      expect(web.exitCode, output).toBeNull();
      // eslint-disable-next-line no-control-regex -- Angular may print ANSI colour codes.
      base = /Local:\s+(http:\/\/127\.0\.0\.1:\d+)/u.exec(output.replace(/\u001b\[[0-9;]*m/gu, ''))?.[1] ?? '';
      expect(base, output).not.toBe(''); expect(await fetch(base).then(r => r.ok, () => false)).toBe(true);
    }, { timeout: 120_000, interval: 200 });
    config.redirectUri = `${base}/auth/callback`;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${base}/claim`);
    await page.getByRole('heading', { name: 'Claim this silo' }).waitFor({ timeout: 10_000 });
    expect(await page.getByRole('link', { name: 'Sign in to claim' }).getAttribute('href')).toBe('/auth/login?returnTo=/claim');
    await context.addCookies([{ name: config.cookieName, value: encodeSession(config, {
      sub: 'alice', orgId: 'org-acme', roles: [], authTime: 0, exp: 2_000_000_000, name: 'Alice' }), url: base }]);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${base}/claim`);
      await page.getByLabel('Display name').fill('Alice');
      await page.getByLabel('Contact email').fill('alice@example.test');
      await page.getByLabel('Bootstrap token').fill('wrong');
      await page.getByLabel('Bootstrap token').press('Tab');
      expect(await page.getByRole('button', { name: 'Claim this silo' }).evaluate(e => e === document.activeElement)).toBe(true);
      await page.keyboard.press('Enter');
      await page.getByText('That token is incorrect. Check it with the installer.').waitFor();
      expect(await page.getByLabel('Bootstrap token').inputValue()).toBe('');
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      for (const control of await page.locator('input, button').all()) expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: `/tmp/bootstrap-claim-${width}.png`, fullPage: true });
    }
    await page.getByLabel('Bootstrap token').fill(token);
    await page.getByRole('button', { name: 'Claim this silo' }).press('Enter');
    await page.getByRole('heading', { name: 'You are the silo owner' }).waitFor();
    expect(await page.locator('body').innerText()).not.toContain(token);
    expect(await page.locator('input[type=password]').count()).toBe(0);
    await page.reload();
    await page.getByLabel('Contact email').fill('alice@example.test');
    await page.getByLabel('Bootstrap token').fill(token);
    await page.getByRole('button', { name: 'Claim this silo' }).press('Enter');
    await page.getByText('This token has already been used.').waitFor();
    expect(await nats.store.head()).toBe(1);
    await context.close();
  } finally {
    await browser.close(); web.kill('SIGTERM');
    const kill = setTimeout(() => web.kill('SIGKILL'), 5000); await exited; clearTimeout(kill);
    await app.close(); await nats.close(); await rm(directory, { recursive: true, force: true });
  }
}, 240_000);
