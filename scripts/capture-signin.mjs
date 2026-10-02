import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const output = '/home/jente/.fleet/signin-shots';
const origin = 'https://ocn-dev.tail00285e.ts.net';
const references = '/home/jente/.fleet/design/design_handoff_chat/wireframes';
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [frame, name, path, title] of [
    ['1a', 'sign-in', '/', 'Sign in to your workspace'],
    ['1b', 'idp-handoff', '/signin/handoff', 'Taking you to your identity provider'],
    ['1d', 'sign-in-rejected', '/signin/rejected?reason=organisation', 'Sign in to your workspace'],
  ]) {
    await copyFile(`${references}/01-${frame}-${name}.png`, `${output}/reference-${frame}.png`);
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: 'reduce' });
      // Freeze the handoff timer in the browser for this transient-screen capture.
      if (frame === '1b') await page.addInitScript(() => {
        const original = globalThis.setTimeout;
        globalThis.setTimeout = (handler, timeout, ...args) => original(handler, timeout === 100 ? 60_000 : timeout, ...args);
      });
      try {
        await page.goto(`${origin}${path}`);
        await page.getByRole('heading', { name: title, exact: true }).waitFor();
        await page.evaluate(() => globalThis.document.fonts.ready);
        assert(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), 'No horizontal overflow');
        await page.screenshot({ path: `${output}/${frame}-${width}.png`, fullPage: true });
      } finally { await page.close(); }
      const comparison = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
      const html = `<!doctype html><title>${frame} at ${width}px</title><style>body{font:16px system-ui;background:#eceff0;margin:24px}section{display:flex;gap:24px}article{width:700px}img{max-width:100%;max-height:920px;object-fit:contain;object-position:top left}</style><h1>${frame} · ${width}px</h1><section><article><h2>Design reference</h2><img src="reference-${frame}.png"></article><article><h2>Live implementation</h2><img src="${frame}-${width}.png"></article></section>`;
      await writeFile(`${output}/compare-${frame}-${width}.html`, html);
      await comparison.goto(`file://${output}/compare-${frame}-${width}.html`);
      await comparison.screenshot({ path: `${output}/compare-${frame}-${width}.png`, fullPage: true });
      await comparison.close();
    }
  }
} finally { await browser.close(); }
console.log(`PASS sign-in screenshots and 390px overflow checks: ${output}`);
