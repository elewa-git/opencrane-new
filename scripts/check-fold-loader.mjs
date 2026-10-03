import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';

const capture = process.argv.includes('--capture');
const output = resolve('docs/design/motion/fold-loader');
const before = process.argv.includes('--before');
let web, exited, origin = process.env['CHAT_BASE_URL'];
if (!origin) {
  let logs = '';
  web = spawn(process.execPath, ['--experimental-strip-types', '--import', resolve('apps/server/test/support/ephemeral-ports.ts'), resolve('node_modules/@angular/cli/bin/ng.js'), 'serve', '--prebundle=false', '--live-reload=false', '--hmr=false', '--host', '127.0.0.1', '--port', '0'],
    { cwd: resolve('apps/web'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
  exited = once(web, 'exit');
  web.stdout.on('data', chunk => { logs += chunk.toString(); }); web.stderr.on('data', chunk => { logs += chunk.toString(); });
  const deadline = Date.now() + 90_000;
  while (!origin) {
    origin = /Local:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(logs)?.[1];
    if (web.exitCode !== null || Date.now() > deadline) { web.kill(); throw new Error(`Angular did not start: ${logs}`); }
    await delay(100);
  }
}
const browser = await chromium.launch();

try {
  await mkdir(output, { recursive: true });
  for (const width of [1280, 390]) {
    for (const place of ['handoff', 'folding', 'streaming']) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      if (place === 'handoff') { await page.clock.install({ time: new Date("2026-10-03T00:00:00Z") }); await page.clock.pauseAt(new Date("2026-10-03T00:00:01Z")); }
      await chatFixture(page, place);
      await page.goto(`${origin}${place === 'handoff' ? '/signin/handoff' : '/workspace?conversation=chat'}`);
      const loader = page.locator(before ? (place === 'handoff' ? '.folds' : '.fold') : 'oc-fold-loader');
      await loader.waitFor({ timeout: 10_000 });
      await page.evaluate(() => globalThis.document.fonts.ready);
      if (!before) {
        assert.equal(await loader.getAttribute('aria-hidden'), 'true');
        assert(await loader.evaluate(node => node.getAnimations({ subtree: true }).length > 0), 'Fold animates');
        assert.equal(await loader.locator('[style]').count(), 0, 'No runtime inline styles');
        const foldedWidth = await loader.evaluate(node => {
          for (const animation of node.getAnimations({ subtree: true })) { animation.pause(); animation.currentTime = 850; }
          const panels = [...node.querySelectorAll('.wing')].map(panel => panel.getBoundingClientRect());
          return Math.max(...panels.map(panel => panel.right)) - Math.min(...panels.map(panel => panel.left));
        });
        assert(foldedWidth < 50, `Panels stack into one triangle: ${foldedWidth}px`);
      }
      assert(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), 'No horizontal overflow');
      const box = await loader.boundingBox();
      assert(box.x >= 0 && box.x + box.width <= width, 'Loader fits viewport');
      if (place === 'handoff') assert(Math.abs(box.x + box.width / 2 - width / 2) < 1, 'Handoff loader is centred');
      if (capture) {
        await page.screenshot({ path: `${output}/${before ? 'before' : 'after'}-${place}-${width}.png` });
        if (!before && width === 1280 && place === 'handoff') {
          for (let frame = 0; frame < 32; frame++) {
            await loader.evaluate((node, time) => {
              for (const animation of node.getAnimations({ subtree: true })) { animation.pause(); animation.currentTime = time; }
            }, frame * 50);
            await loader.screenshot({ path: `${output}/frame-${String(frame).padStart(2, '0')}.png` });
          }
        }
      }
      await page.emulateMedia({ reducedMotion: 'reduce' });
      if (!before) assert.equal(await loader.evaluate(node => node.getAnimations({ subtree: true }).length), 0, 'Reduced motion is static');
      if (capture && !before) await page.screenshot({ path: `${output}/reduced-${place}-${width}.png` });
      await page.close();
    }
  }
  if (!before) {
    for (const key of [null, 'Enter', 'Space']) {
      const page = await browser.newPage();
      await page.clock.install({ time: new Date("2026-10-03T00:00:00Z") });
      await page.clock.pauseAt(new Date("2026-10-03T00:00:01Z"));
      await page.route('**/auth/me', route => route.fulfill({ json: { authenticated: false } }));
      let redirects = 0;
      await page.route('**/auth/login?**', route => { redirects++; return route.fulfill({ body: 'Identity provider' }); });
      await page.goto(`${origin}/signin/handoff`);
      const cancel = page.getByRole('button', { name: 'Cancel and go back' });
      await cancel.waitFor();
      assert(await cancel.evaluate(node => node === globalThis.document.activeElement));
      assert.match(await page.locator('[aria-live=polite]').innerText(), /Opening single sign-on…/);
      await page.clock.runFor(2400);
      assert.equal(redirects, 0, 'No redirect before 2.5 seconds');
      if (key) {
        await page.keyboard.press(key);
        await page.waitForURL(origin + '/');
        await page.clock.runFor(10_000);
        assert.equal(redirects, 0, 'Cancel prevents redirect');
      } else {
        const request = page.waitForRequest('**/auth/login?**');
        await page.clock.runFor(150);
        await request;
        await page.waitForURL('**/auth/login?**');
        assert.equal(redirects, 1, 'Redirect within 2.55 seconds');
      }
      await page.close();
    }
  }
  console.log(before ? 'PASS baseline fold captures' : 'PASS fold loader Chromium: placements, motion, 390px, 2.5-second redirect and keyboard Cancel');
} finally {
  await browser.close();
  if (web) { web.kill(); await exited; }
}
