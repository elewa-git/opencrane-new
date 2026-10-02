import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { chromium } from '/app/node_modules/playwright-core/index.mjs';
process.setgroups([]); process.setgid(1002); process.setuid(1002);
process.env.HOME = '/home/desktop';
assert.equal(process.getuid(), 1002);
assert.match(readFileSync('/proc/self/status', 'utf8'), /NoNewPrivs:\s+1/);
assert.throws(() => readFileSync('/home/codex/caller'), { code: 'EACCES' });
assert.throws(() => readdirSync('/home/agent/codex'), { code: 'EACCES' });
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, chromiumSandbox: true, args: [ '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  await page.setContent('<h1>OpenCrane desktop</h1>');
  assert.equal(await page.locator('h1').textContent(), 'OpenCrane desktop');
  let chromiumProcesses = 0, desktopProcesses = 0;
  for (const pid of readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
    let status;
    try { status = readFileSync(`/proc/${pid}/status`, 'utf8'); } catch { continue; }
    if (!/Name:\s+(chromium|Xvnc)/.test(status)) continue;
    assert.match(status, /Uid:\s+1002\s/); assert.match(status, /NoNewPrivs:\s+1/);
    if (status.includes('chromium')) chromiumProcesses++; else desktopProcesses++;
  }
  assert.ok(chromiumProcesses > 0); assert.equal(desktopProcesses, 1);
  console.log('DESKTOP_PASS');
} finally { await browser.close(); }
