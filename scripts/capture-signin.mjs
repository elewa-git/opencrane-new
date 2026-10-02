import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const output = '/home/jente/.fleet/signin-shots';
const origin = 'https://ocn-dev.tail00285e.ts.net';
const source = '/home/jente/.fleet/design/design_handoff_chat/design/Onboarding Wireframes.dc.html';
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  const reference = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await reference.goto(`file://${source}`);
  await reference.evaluate(() => globalThis.document.fonts.ready);
  for (const [frame, path, title] of [
    ['1a', '/?invitation=visual-check', 'Sign in to your workspace'],
    ['1b', '/signin/handoff', 'Taking you to your identity provider'],
    ['1d', '/signin/rejected?reason=organisation', 'Sign in to your workspace'],
  ]) {
    // Crop the actual source to its card, excluding canvas labels and notes, at 1x.
    const referenceCard = reference.locator(`[id="${frame}"] > div`).nth(1);
    await referenceCard.screenshot({ path: `${output}/reference-${frame}.png`, scale: 'css' });
    const expected = await referenceCard.boundingBox();
    assert(expected);
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      if (frame === '1b') await page.clock.install();
      try {
        await page.goto(`${origin}${path}`);
        await page.getByRole('heading', { name: title, exact: true }).waitFor();
        await page.evaluate(() => globalThis.document.fonts.ready);
        const card = page.locator('main.sign-in');
        const box = await card.boundingBox();
        assert(box);
        assert(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), 'No horizontal overflow');
        if (width === 1280) {
          assert.equal(box.width, expected.width, `${frame} card width`);
          assert.equal(box.height, expected.height, `${frame} card height`);
        }
        const style = await card.evaluate((element) => {
          const css = globalThis.getComputedStyle(element);
          return { background: css.backgroundColor, border: css.borderTopColor, radius: css.borderRadius, padding: css.paddingLeft };
        });
        assert.equal(style.background, 'rgb(251, 252, 252)');
        if (width === 1280) {
          assert.equal(style.border, 'rgb(217, 223, 224)');
          assert.equal(style.radius, '11px');
          assert.equal(style.padding, frame === '1b' ? '44px' : '56px');
        }
        for (const target of await card.locator('button, input, a.text-button').all()) {
          assert((await target.boundingBox()).height >= 44, 'Controls retain 44px targets');
        }
        if (frame !== '1b') {
          const organisation = await page.locator('meta[name=opencrane-org]').getAttribute('content');
          assert.equal(await page.locator('.eyebrow').textContent(), organisation);
          assert.equal(await page.locator('footer').textContent(), 'self-hosted · data sovereign');
          assert.equal(await page.locator('.primary').evaluate((element) => globalThis.getComputedStyle(element).backgroundColor), 'rgb(47, 141, 154)');
          assert.equal(await page.locator('.content').evaluate((element) => globalThis.getComputedStyle(element).gap), '14px');
          if (frame === '1a') {
            assert(await page.getByText(`You were invited by ${organisation}. Your work here stays private to you.`, { exact: true }).isVisible());
            assert(await page.getByText('Email sign-in is unavailable', { exact: true }).isVisible());
          }
        }
        await card.screenshot({ path: `${output}/${frame}-${width}.png`, scale: 'css' });
      } finally { await page.close(); }
      const comparison = await browser.newPage({ viewport: { width: 1160, height: 1050 }, deviceScaleFactor: 1 });
      const html = `<!doctype html><title>${frame} at ${width}px</title><style>body{font:16px system-ui;background:#eceff0;margin:24px}section{display:flex;gap:24px}img{display:block}</style><h1>${frame} · ${width}px · both at 1x</h1><section><article><h2>Design card</h2><img src="reference-${frame}.png"></article><article><h2>Live card</h2><img src="${frame}-${width}.png"></article></section>`;
      await writeFile(`${output}/compare-${frame}-${width}.html`, html);
      await comparison.goto(`file://${output}/compare-${frame}-${width}.html`);
      await comparison.screenshot({ path: `${output}/compare-${frame}-${width}.png`, fullPage: true });
      await comparison.close();
    }
  }
  await reference.close();
  // Real keyboard activation and browser clock: no provider mocking or sleeps.
  for (const key of ['Enter', 'Space']) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.clock.install();
    await page.goto(`${origin}/signin/handoff`);
    const cancel = page.getByRole('button', { name: 'Cancel and go back' });
    await cancel.waitFor();
    assert(await cancel.evaluate((element) => element === globalThis.document.activeElement));
    await page.clock.runFor(4000);
    assert.equal(new URL(page.url()).pathname, '/signin/handoff');
    assert.match(await page.locator('[aria-live=polite]').textContent(), /1 second…/);
    await page.keyboard.press(key);
    await page.waitForURL(origin + '/');
    await page.clock.runFor(10_000);
    assert.equal(new URL(page.url()).pathname, '/');
    await page.close();
  }
  const page = await browser.newPage();
  await page.clock.install();
  await page.goto(`${origin}/signin/handoff`);
  await page.getByRole('button', { name: 'Cancel and go back' }).waitFor();
  await page.clock.runFor(4999);
  assert.equal(new URL(page.url()).pathname, '/signin/handoff');
  const redirect = page.waitForRequest(`${origin}/auth/login?returnTo=/`);
  await page.clock.runFor(1);
  await redirect;
  await page.close();
} finally { await browser.close(); }
console.log(`PASS 6 sign-in captures: 1x geometry, tokens, copy, 390px/44px; keyboard Cancel (Enter/Space), focus and five-second redirect: ${output}`);
