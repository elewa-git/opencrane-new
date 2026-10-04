import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';

await promisify(execFile)('npm', ['run', 'build', '-w', 'apps/web'], { env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }, timeout: 120_000 });
const root = resolve('apps/web/dist/web/browser');
const server = createServer((request, response) => {
  void (async () => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const file = path === '/workspace' ? '/index.html' : path;
    if (file.includes('..')) { response.writeHead(400).end(); return; }
    let body = await readFile(root + file);
    const nonce = randomBytes(18).toString('base64');
    if (file === '/index.html') body = Buffer.from(body.toString().replace('<app-root', `<app-root ngCspNonce="${nonce}"`));
    response.writeHead(200, {
      'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.jpg': 'image/jpeg' })[extname(file)] ?? 'application/octet-stream',
      'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self' ws:; object-src 'none'; base-uri 'self'`,
    });
    response.end(body);
  })().catch(() => response.writeHead(404).end());
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const violations = [];
  await page.exposeFunction('recordViolation', value => violations.push(value));
  await page.addInitScript(() => globalThis.document.addEventListener('securitypolicyviolation', event => {
    void globalThis.recordViolation(`${event.violatedDirective}: ${event.blockedURI}`);
  }));
  const fixture = await chatFixture(page, 'draft');
  await page.goto(`http://127.0.0.1:${server.address().port}/workspace`);
  const composer = page.getByRole('textbox', { name: 'Message your agent' });
  await composer.fill('Works under CSP');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByRole('article', { name: 'Your message', exact: true }).filter({ hasText: 'Works under CSP' }).waitFor();
  const message = fixture.rows().find(row => row.type === 'message.posted');
  fixture.add('agent.turn_started', { turnId: message.id });
  const loader = page.locator('oc-fold-loader');
  await loader.waitFor();
  assert(await loader.evaluate(node => node.getAnimations({ subtree: true }).length > 0), 'Fold animates under enforcing CSP');
  await page.evaluate(() => globalThis.document.fonts.ready);
  assert.deepEqual(violations, [], 'Production has no blocked styles or scripts');
  assert.equal(await page.locator('.main').evaluate(node => globalThis.getComputedStyle(node).display), 'grid');
  assert.match(await composer.evaluate(node => globalThis.getComputedStyle(node).fontFamily), /DM Sans/);
  console.log('PASS production Chromium under enforcing CSP');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
