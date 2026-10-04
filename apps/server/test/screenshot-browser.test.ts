/// <reference lib="dom" />
import { createServer } from 'node:net';
import { once } from 'node:events';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import { encodeSession } from '@opencrane/auth';
import { grantStream } from '@opencrane/authz';
import { files, conversations } from '@opencrane/projections';
import { until } from '@opencrane/authz/testing';
import { buildServer } from '../src/server.ts';
import { attachWebSocketServer } from '../src/websocket.ts';
import { viewFixture } from './support/view-fixture.ts';
import { uploadServices } from './support/upload-services.ts';
import { screenshotDesktop } from './support/screenshot-desktop.ts';

it.runIf(process.env['SCREENSHOT_BROWSER'] === '1')('captures real desktop pixels and reopens them from the conversation and panel at 1280 and 390px', async () => {
  const desktop = await screenshotDesktop(), services = await uploadServices();
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const bound = reservation.address(); if (!bound || typeof bound === 'string') throw new Error('No port');
  const port = bound.port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const fixture = await viewFixture(desktop.open, `http://127.0.0.1:${port}/auth/callback`);
  const { config, nats, db, binding, feed, keys, runner } = fixture;
  const options = { silo: 'test', store: nats.store, db, binding, feed, keys };
  let release: (() => void) | undefined, scanning = false;
  let failScan = false, infected = false;
  const app = buildServer(config, { chat: options, liveView: { ...options, open: desktop.open }, files: { ...options, objects: services.objects, async scan(bytes) {
    if (failScan) throw new Error('Scanner unavailable');
    if (infected) return 'infected';
    scanning = true; await new Promise<void>(resolve => { release = resolve; }); return services.scan(bytes);
  } } });
  const realtime = attachWebSocketServer(app.server, app.log, config, { binding, feed, chat: options });
  const browser = await chromium.launch({ headless: true });
  const output = 'apps/computer/.state/p318'; await mkdir(output, { recursive: true });
  try {
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
    await runner.initialise(files);
    app.get('/workspace', async (_request, reply) => reply.type('text/html').send(await readFile('apps/web/dist/web/browser/index.html')));
    app.get('/*', async (request, reply) => {
      if (!/^\/[\w.-]+$/u.test(request.url)) return reply.code(404).send();
      return reply.type(request.url.endsWith('.js') ? 'application/javascript' : 'text/css').send(await readFile(`apps/web/dist/web/browser${request.url}`));
    });
    const address = await app.listen({ host: '127.0.0.1', port });
    const cookie = encodeSession(config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+600 });
    const hashes: string[] = [];
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.context().addCookies([{ name: config.cookieName, value: cookie, url: address }]);
      await page.goto(`${address}/workspace?conversation=chat`);
      if (width === 390) await page.getByRole('button', { name: 'Session panel', exact: true }).click();
      const watch = page.getByRole('button', { name: 'Watch your computer', exact: true }); await watch.focus(); await page.keyboard.press('Enter');
      await page.getByText('Viewing', { exact: true }).waitFor({ timeout: 20_000 });
      const capture = page.getByRole('button', { name: 'Screenshot', exact: true });
      await capture.waitFor({ timeout: 2000 });
      expect((await capture.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await capture.focus(); await page.keyboard.press('Enter');
      await until(() => scanning); scanning = false;
      await page.getByText('Capturing and scanning…', { exact: true }).waitFor();
      expect(await capture.isDisabled()).toBe(true);
      await page.screenshot({ path: `${output}/progress-${width}.png` }); release?.();
      await page.getByText('Screenshot saved', { exact: true }).waitFor();
      await runner.run(files); await runner.run(conversations);
      const canvasPixels = await page.locator('canvas').evaluate(async (canvas: HTMLCanvasElement) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', canvas.getContext('2d')!.getImageData(0, 0, 800, 600).data))));
      await page.getByRole('button', { name: 'Close view', exact: true }).click({ timeout: 3000 }).catch(async error => { await page.screenshot({ path: `${output}/failure-${width}.png` }); throw new Error(await page.locator('body').innerText(), { cause: error }); });
      if (width === 390) await page.getByRole('button', { name: 'Close session panel', exact: true }).click();
      await page.reload();
      const card = page.locator('.file-card').last(); await card.waitFor();
      await card.locator('img').evaluate((image: HTMLImageElement) => image.decode());
      await page.screenshot({ path: `${output}/thumbnail-${width}.png` });
      await card.getByRole('button', { name: 'Open', exact: true }).focus(); await page.keyboard.press('Enter');
      const preview = page.getByRole('dialog', { name: 'File preview', exact: true });
      await preview.getByText('Preview ready', { exact: true }).waitFor();
      const pixels = await preview.locator('img').evaluate(async (image: HTMLImageElement) => {
        await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        canvas.getContext('2d')!.drawImage(image, 0, 0); return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data)));
      });
      expect(pixels).toEqual(canvasPixels); hashes.push(Buffer.from(pixels).toString('hex'));
      await page.screenshot({ path: `${output}/preview-${width}.png` });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.keyboard.press('Escape'); await preview.waitFor({ state: 'hidden' });
      if (width === 390) await page.getByRole('button', { name: 'Session panel', exact: true }).click();
      await page.locator('.panel-file:visible').last().click(); await preview.getByText('Preview ready', { exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await watch.click(); await page.getByText('Viewing', { exact: true }).waitFor();
      failScan = true;
      await capture.click();
      await page.getByText('Screenshot could not be saved. Retry.', { exact: true }).waitFor();
      expect(await page.locator('oc-live-view [data-state=failed]').count()).toBe(1);
      expect(await page.locator('oc-live-view [data-state=unknown]').count()).toBe(0);
      await page.screenshot({ path: `${output}/error-${width}.png` }); failScan = false;
      infected = true; await capture.click();
      await page.getByText('File rejected: malware detected', { exact: true }).waitFor({ timeout: 3000 });
      expect(await page.locator('oc-live-view [data-state=refused]').count()).toBe(1);
      infected = false; await capture.click(); await until(() => scanning); scanning = false; release?.();
      await page.getByText('Screenshot saved', { exact: true }).waitFor();
      await page.close();
    }
    await writeFile(`${output}/receipt.json`, JSON.stringify({ date: new Date().toISOString(), image: desktop.image, hashes, status: 'PASS', fresh: 'Disposable desktop, NATS, databases, OpenFGA, MinIO and ClamAV; no owner stack', widths: [1280, 390] }, null, 2));
  } finally {
    release?.(); await browser.close(); await new Promise<void>(resolve => realtime.close(() => resolve()));
    await app.close(); await fixture.close(); await services.close(); await desktop.close();
  }
}, 180_000);
