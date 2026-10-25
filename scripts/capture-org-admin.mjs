import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const output = resolve('.tools/org-admin-shots');
const base = 'http://127.0.0.1:4200';
const row = (serverId, name, kind, label, detail, total, allowed,
  source = { kind: 'remote_url', label: 'Remote URL', detail: `${serverId}.example.com` },
  version = 'Version not provided') => ({ serverId, name, source,
  version, accountModel: 'Not provided', toolsAllowed: allowed, toolsTotal: total,
  status: { kind, label, detail } });
const body = { loadedAt: '2026-10-01T09:40:00.000Z', rows: [
  row('odoo', 'Odoo', 'ready', 'Ready', 'Published 1 Oct 2026, 08:00', 14, 9,
    { kind: 'catalogue', label: 'Catalogue', detail: 'catalogue:odoo' }, '1.4.2'),
  row('microsoft-365', 'Microsoft 365', 'needs_input', 'Needs input', 'Connect each person’s account', 22, 6),
  row('slack', 'Slack', 'failed', 'Failed', 'Authorisation expired', 11, 4),
  row('pricing', 'Kijani pricing API', 'needs_input', 'Needs input', 'Pending review · tools changed', 3, 3),
  row('warehouse', 'Warehouse scanner', 'checking', 'Applying / checking', 'Validating package…', null, 0),
] };

await mkdir(output, { recursive: true });
const server = spawn('npm', ['run', 'dev', '-w', 'apps/web', '--', '--host', '127.0.0.1', '--port', '4200'], { stdio: 'ignore' });
try {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { if ((await fetch(base)).ok) break; } catch { /* The dev server is still starting. */ }
    await new Promise((done) => setTimeout(done, 250));
  }
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
      await page.route('**/api/org/integrations', async (route) => {
        if (route.request().resourceType() === 'fetch') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        } else await route.continue();
      });
      await page.goto(`${base}/org/integrations`);
      await page.locator('.register-row').first().waitFor();
      await page.screenshot({ path: `${output}/register-${width}.png`, fullPage: true });
      await page.goto(`${base}/org/states`);
      await page.locator('.state-row').first().waitFor();
      await page.screenshot({ path: `${output}/shared-states-${width}.png`, fullPage: true });
      const design = pathToFileURL(resolve('docs/design/org-admin/design/Organisation Admin.dc.html')).href;
      await page.goto(design);
      for (const frame of ['4a', '6a']) {
        await page.locator(`[id="${frame}"]`).screenshot({ path: `${output}/design-${frame}-${width}.png` });
      }
      await page.close();
    }
  } finally { await browser.close(); }
} finally {
  server.kill('SIGTERM');
}
