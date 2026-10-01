// Real Chromium, a disk profile and CDP. No browser library or mocked cookie store.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { token } = JSON.parse(readFileSync(0, 'utf8'));
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
process.setgroups([]); process.setgid(1002); process.setuid(1002);
const browser = spawn('chromium', ['--headless', '--no-sandbox', '--disable-dev-shm-usage',
  '--disable-background-networking', '--disable-component-update', '--password-store=basic',
  '--user-data-dir=/home/agent/profile', '--remote-debugging-port=9222', 'about:blank'],
  { env: { PATH: process.env.PATH, HOME: '/home/desktop' }, stdio: 'ignore' });
let ws;
try {
  let pages;
  for (let i = 0; i < 150; i++) {
    pages = await fetch('http://127.0.0.1:9222/json').then(r => r.json()).catch(() => null);
    if (pages?.length) break; await sleep(100);
  }
  assert.ok(pages?.length, 'Chromium started');
  ws = new WebSocket(pages[0].webSocketDebuggerUrl); await once(ws, 'open');
  let id = 0; const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  await rpc('Network.enable');
  await rpc('Network.setExtraHTTPHeaders', { headers: { 'x-desktop-token': token } });
  await rpc('Page.enable');
  await rpc('Page.navigate', { url: process.argv[2] + (process.argv[3] === 'login' ? '/login' : '/account') });
  let value;
  for (let i = 0; i < 100; i++) {
    value = (await rpc('Runtime.evaluate', { expression: 'document.body.innerText' })).result.value;
    if (value?.includes('LOGGED_IN')) break; await sleep(100);
  }
  assert.match(value, /LOGGED_IN/, 'server recognised persisted login cookie');
  console.log('BROWSER_PASS ' + process.argv[3]);
  await rpc('Browser.close'); await once(browser, 'exit');
} finally { ws?.close(); browser.kill(); }
