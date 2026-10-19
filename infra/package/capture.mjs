import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { enterLoginName } from '../dev-stack/browser-signin.ts';
import { directory } from '../dev-stack/config.ts';
import { browserFailure } from './browser-capture.ts';
import { secondary, stackId } from '../dev-stack/identity.ts';

assert(secondary, 'Capture requires a claimed secondary slot');
const port = 25000 + Number(stackId) * 100 + 6;
const origin = `http://127.0.0.1:${port}`;
const output = 'docs/process/p5-1-live';
const prefix = process.argv[2];
assert(/^fresh-[12]-$/u.test(prefix), 'Pass fresh-1- or fresh-2- as the capture prefix');
const setup = JSON.parse(await readFile(`${directory}/zitadel.json`, 'utf8'));
const owner = setup.users.owner;
const signIns = [];
let stage = 'browser launch';
let browser;

function atApp(url) {
  return url.origin === origin && !url.pathname.startsWith('/auth/');
}

async function completeChatTurn(page, width) {
  await page.getByRole('link', { name: 'Open workspace', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'Message your agent' });
  await composer.waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => !document.querySelector('.skeleton'));
  await page.keyboard.press('Control+n');
  await page.getByText('Draft', { exact: true }).waitFor();
  await composer.fill('Say hello briefly.');
  await composer.press('Enter');
  const reply = page.getByRole('article', { name: 'Agent reply', exact: true });
  await reply.filter({ hasText: 'Hello from your computer.' }).waitFor({ timeout: 120_000 });
  await reply.getByText('Done', { exact: true }).waitFor();
  await page.screenshot({ path: `${output}/${prefix}chat-${width}.png`, fullPage: true });
  console.log(`PASS stub-model browser chat at ${width}px`);
}

try {
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  await mkdir(output, { recursive: true });
  for (const width of [1280, 390]) {
    stage = `${width}px home`;
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.goto(origin);
    stage = `${width}px SSO button`;
    await page.getByRole('button', { name: 'Continue with single sign-on' }).click();
    stage = `${width}px login name`;
    const login = page.locator('input[name=loginName]');
    await login.waitFor();
    await page.waitForLoadState('networkidle');
    await enterLoginName(page, owner.login);
    stage = `${width}px password`;
    const password = page.locator('input[type=password]');
    await password.waitFor();
    await password.fill(await readFile(owner.passwordFile, 'utf8'));
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    stage = `${width}px return`;
    await page.waitForURL(atApp);
    stage = `${width}px session`;
    const response = await page.request.get(`${origin}/auth/me`);
    const session = await response.json();
    assert.equal(session.authenticated, true);
    assert.equal(session.user?.sub, owner.id);
    signIns.push({ width, authenticated: session.authenticated,
      subject: session.user?.sub });
    stage = `${width}px signed-in page`;
    await page.getByRole('heading', { name: 'You are signed in' }).waitFor();
    await page.screenshot({ path: `${output}/${prefix}signed-in-${width}.png`, fullPage: true });
    stage = `${width}px chat turn`;
    await completeChatTurn(page, width);
    await context.close();
    console.log(`PASS signed-in package screenshot at ${width}px`);
  }
  console.log(JSON.stringify(signIns));
} catch (error) {
  console.error(browserFailure(stage, error));
  process.exitCode = 1;
} finally {
  await browser?.close();
}
