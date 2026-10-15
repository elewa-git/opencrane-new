import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/screen-p4-19-signin');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://screen-p4-19-signin.opencrane.test';
const screens = [
  { name: 'ONB-01', path: '/', heading: 'Sign in to OpenCrane' },
  { name: 'ONB-01-invited', path: '/?invitation=sample', heading: 'Sign in to OpenCrane' },
  { name: 'ONB-02', path: '/signin/handoff', heading: 'Sign in to OpenCrane' },
  { name: 'ONB-03-organisation', path: '/signin/rejected?reason=organisation', heading: 'Sign in to OpenCrane' },
  { name: 'ONB-03-unavailable', path: '/signin/rejected?reason=unavailable', heading: 'Sign in to OpenCrane' },
  { name: 'ONB-03-rejected', path: '/signin/rejected?reason=rejected', heading: 'Sign in to OpenCrane' },
];

async function serve(route) {
  const url = new URL(route.request().url());
  if (url.pathname === '/auth/me') {
    await route.fulfill({ json: { authenticated: false } });
    return;
  }
  if (url.pathname === '/auth/login') {
    await route.fulfill({ body: 'Identity provider' });
    return;
  }
  if (url.pathname.startsWith('/auth/')) assert.fail(`Unexpected auth request: ${url.pathname}`);
  await serveWebBuild(route, build);
}

function undersizedControls(controls) {
  const small = [];
  for (const control of controls) {
    const bounds = control.getBoundingClientRect();
    if (Math.round(bounds.width) < 44 || Math.round(bounds.height) < 44) {
      small.push(control.outerHTML.slice(0, 80));
    }
  }
  return small;
}

function isFocused(node) {
  return node === globalThis.document.activeElement;
}

function animationName(node) {
  return globalThis.getComputedStyle(node).animationName;
}

async function checkTargets(page, name, width) {
  const small = await page.locator('button:visible, input:visible, a.button:visible')
    .evaluateAll(undersizedControls);
  assert.deepEqual(small, [], `${name} has 44px controls at ${width}px`);
}

async function checkCard(page, name, width) {
  assert(await page.evaluate(pageHasNoOverflow), `${name} has no overflow at ${width}px`);
  const card = page.locator('.sign-in-card');
  const bounds = await card.boundingBox();
  assert(bounds, `${name} has a card`);
  if (width === 1280) {
    assert(Math.abs(bounds.width - 456) <= 2, `${name} desktop card is about 456px wide`);
    assert(Math.abs(bounds.x + bounds.width / 2 - width / 2) <= 2, `${name} card is centred`);
  } else {
    assert(bounds.x >= 16 && bounds.x <= 18, `${name} left gutter is 16px`);
    assert(width - bounds.x - bounds.width >= 16, `${name} right gutter is 16px`);
  }
  await checkTargets(page, name, width);
}

async function capture(browser, screen, width) {
  const page = await browser.newPage({
    viewport: { width, height: width === 1280 ? 900 : 844 },
    reducedMotion: 'reduce',
  });
  await page.route('**/*', serve);
  if (screen.name === 'ONB-02') {
    await page.clock.install({ time: new Date('2026-10-15T09:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-15T09:00:01Z'));
  }
  try {
    await page.goto(`${origin}${screen.path}`);
    await page.getByRole('heading', { name: screen.heading }).waitFor();
    if (screen.name.startsWith('ONB-01')) {
      const sso = page.getByRole('button', { name: 'Continue with single sign-on' });
      await sso.waitFor();
      assert(await sso.evaluate(isFocused), 'SSO is focused');
    }
    if (screen.name === 'ONB-02') {
      const cancel = page.getByRole('button', { name: 'Cancel and go back' });
      assert(await cancel.evaluate(isFocused), 'Cancel is focused');
      assert.match(await page.locator('[role=status]').innerText(), /Opening single sign-on…/);
      assert.match(await page.locator('[data-glyph-name=spinner] .spinner')
        .evaluate(animationName), /none/);
    }
    if (screen.name.startsWith('ONB-03')) {
      assert.equal(await page.locator('[role=status]').count(), 1);
      assert.equal(await page.locator('[role=alert]').count(), 0);
    }
    await page.evaluate(waitForFonts);
    await checkCard(page, screen.name, width);
    const filename = `${screen.name}-${width}.png`;
    await page.screenshot({ path: `${output}/${filename}`, fullPage: true });
    return filename;
  } finally {
    await page.close();
  }
}

async function checkHandoff(browser, key) {
  const page = await browser.newPage();
  await page.route('**/*', serve);
  await page.clock.install({ time: new Date('2026-10-15T09:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-15T09:00:01Z'));
  try {
    await page.goto(`${origin}/signin/handoff`);
    const cancel = page.getByRole('button', { name: 'Cancel and go back' });
    await cancel.waitFor();
    await page.clock.runFor(2400);
    assert.equal(new URL(page.url()).pathname, '/signin/handoff');
    if (key) {
      await page.keyboard.press(key);
      await page.waitForURL(origin + '/');
      await page.clock.runFor(10_000);
      assert.equal(new URL(page.url()).pathname, '/');
      return;
    }
    const redirect = page.waitForRequest(`${origin}/auth/login?returnTo=/`);
    await page.clock.runFor(100);
    await redirect;
  } finally {
    await page.close();
  }
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const filenames = [];
  for (const width of [1280, 390]) {
    for (const screen of screens) filenames.push(await capture(browser, screen, width));
  }
  for (const key of ['Enter', 'Space', null]) await checkHandoff(browser, key);
  const receipt = `# Sign-in card screen receipt\n\n` +
    `These captures use intercepted sign-in replies and reduced motion. They do not use a development stack.\n` +
    `The browser checked a centred card at 1280px, 16px phone gutters, no horizontal overflow, ` +
    `44px controls, focus, one polite failure status, Enter and Space cancellation, and the 2.5-second redirect.\n\n` +
    `| Screen | Result | Captures |\n| --- | --- | --- |\n` +
    `| Ready, plain and invited | PASS | ONB-01 and ONB-01-invited, 1280px and 390px |\n` +
    `| Handing off | PASS | ONB-02, 1280px and 390px |\n` +
    `| Rejected, three reasons | PASS | ONB-03-organisation, unavailable and rejected, 1280px and 390px |\n\n` +
    `The captures show the browser layout and intercepted behaviour. A fresh-install sign-in journey is NOT RUN.\n`;
  await writeFile(`${output}/README.md`, receipt);
  console.log(`PASS sign-in captures: ${filenames.join(', ')}`);
} finally {
  await browser.close();
}
