import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { enterLoginName } from '../dev-stack/browser-signin.ts';
import { directory } from '../dev-stack/config.ts';
import { secondary, stackId } from '../dev-stack/identity.ts';

assert(secondary, 'Capture requires a claimed secondary slot');
const port = 25000 + Number(stackId) * 100 + 6;
const origin = `http://127.0.0.1:${port}`;
const output = 'docs/process/p5-1-live';
const setup = JSON.parse(await readFile(`${directory}/zitadel.json`, 'utf8'));
const owner = setup.users.owner;
let stage = 'browser launch';
const browser = await chromium.launch({ headless: true, channel: 'chromium' });

function atApp(url) {
  return url.origin === origin && !url.pathname.startsWith('/auth/');
}

try {
  await mkdir(output, { recursive: true });
  for (const width of [1280, 390]) {
    stage = `${width}px sign-in`;
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.goto(origin);
    await page.getByRole('button', { name: 'Continue with single sign-on' }).click();
    const login = page.locator('input[name=loginName]');
    await login.waitFor();
    await page.waitForLoadState('networkidle');
    await enterLoginName(page, owner.login);
    const password = page.locator('input[type=password]');
    await password.waitFor();
    await password.fill(await readFile(owner.passwordFile, 'utf8'));
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.waitForURL(atApp);
    const response = await page.request.get(`${origin}/auth/me`);
    const session = await response.json();
    assert.equal(session.authenticated, true);
    await page.getByRole('heading', { name: 'You are signed in' }).waitFor();
    await page.screenshot({ path: `${output}/signed-in-${width}.png`, fullPage: true });
    const workspace = await page.request.get(`${origin}/api/chat`);
    console.log(`Package workspace API at ${width}px: HTTP ${workspace.status()}`);
    await context.close();
    console.log(`PASS signed-in package screenshot at ${width}px`);
  }
} catch {
  console.error(`FAIL package screenshot during ${stage}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
