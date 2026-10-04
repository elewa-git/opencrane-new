import { grantStream } from '@opencrane/authz';
/// <reference lib="dom" />
import { rfbViewer } from './support/rfb-viewer.ts';
import { createServer } from 'node:net';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { encodeSession } from '@opencrane/auth';
import { until } from '@opencrane/authz/testing';
import { history } from '@opencrane/models';
import { desktopPod } from './support/desktop-pod.ts';
import { viewFixture } from './support/view-fixture.ts';
import { desktopConnection } from '../src/computers/desktop.ts';

it.runIf(process.env['LIVE_VIEW_K3D'] === '1')('opens desktop pixels with the deployed service account and refuses permissions outside its namespace', async () => {
  const pod = await desktopPod();
  let stream: Awaited<ReturnType<ReturnType<typeof desktopConnection>>> | undefined;
  try {
    stream = await desktopConnection(pod.kubeconfig, pod.namespace)({ computerId: 'desktop', generation: 1, podUid: pod.uid });
    expect((await rfbViewer(stream)).first.pixels).toBe(480000);
    expect(await pod.restricted('auth', 'can-i', 'get', 'pods')).toBe('yes');
    expect(await pod.restricted('auth', 'can-i', 'create', 'pods', '--subresource=exec')).toBe('yes');
    for (const [verb, resource, namespace, subresource] of [
      ['get', 'pods', 'default'], ['create', 'pods', 'default', '--subresource=exec'],
      ['get', 'secrets', pod.namespace], ['create', 'pods', pod.namespace], ['patch', 'pods', pod.namespace],
    ]) await expect(pod.restricted('auth', 'can-i', verb!, resource!, '-n', namespace!, ...(subresource ? [subresource] : []))).rejects.toThrow();
    await pod.k('label', 'pod/desktop', 'app=other', '--overwrite');
    await expect(desktopConnection(pod.kubeconfig, pod.namespace)({ computerId: 'desktop', generation: 1, podUid: pod.uid })).rejects.toThrow('Desktop generation changed');
  } finally { stream?.destroy(); await pod.close(); }
}, 180_000);

it.runIf(process.env['LIVE_VIEW_K3D'] === '1')('renders real gVisor pixels at desktop and phone widths through the authenticated proxy', async () => {
  const pod = await desktopPod();
  let closeFixture: (() => Promise<void>) | undefined;
  let closeBrowser: (() => Promise<void>) | undefined;
  try {
    const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const bound = reservation.address(); if (!bound || typeof bound === 'string') throw new Error('Missing test port');
    const port = bound.port; await new Promise<void>(resolve => reservation.close(() => resolve()));
    const fixture = await viewFixture(desktopConnection(pod.kubeconfig, pod.namespace), `http://127.0.0.1:${port}/auth/callback`);
    closeFixture = fixture.close;
    const { app, config, append } = fixture;
    const browser = await chromium.launch({ headless: true });
    closeBrowser = () => browser.close();
    const output = 'apps/computer/.state/p316'; await mkdir(output, { recursive: true });
    await append('computer-assistant', 'computer.ready', { assistantId: 'assistant', computerId: 'desktop', generation: 1, podUid: pod.uid });
    await append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
    await expect(desktopConnection(pod.kubeconfig, pod.namespace)({ computerId: 'desktop', generation: 1, podUid: 'wrong-uid' })).rejects.toThrow('Desktop generation changed');
    await pod.k('run', 'direct-probe', `--image=${String(pod.image)}`, '--restart=Never', '--labels=app=opencrane-server',
      '--overrides={"spec":{"runtimeClassName":"gvisor"}}', '--', 'node', '-e',
      `fetch('http://${pod.ip}:6901/websockify',{signal:AbortSignal.timeout(1500)}).then(()=>{console.log('REACHED');process.exit(1)},()=>console.log('BLOCKED'))`);
    await pod.k('wait', '--for=jsonpath={.status.phase}=Succeeded', 'pod/direct-probe', '--timeout=60s');
    expect(await pod.k('logs', 'direct-probe')).toBe('BLOCKED');
    const pointerBefore = await pod.k('exec', 'desktop', '--', 'env', 'DISPLAY=:1', 'xdotool', 'getmouselocation', '--shell');
    const direct = await rfbViewer(await desktopConnection(pod.kubeconfig, pod.namespace)({ computerId: 'desktop', generation: 1, podUid: pod.uid }));
    direct.socket.write(Buffer.from([5, 0, 0, 0, 80, 0, 80, 0, 0, 0, 0]));
    expect((await direct.refresh()).pixels).toBe(480000);
    expect(await pod.k('exec', 'desktop', '--', 'env', 'DISPLAY=:1', 'xdotool', 'getmouselocation', '--shell')).toBe(pointerBefore); direct.socket.destroy();
    // Render a known desktop image; its pixels, not a fixture screenshot, travel through Kasm.
    await pod.k('exec', 'desktop', '--', 'sh', '-c', 'DISPLAY=:1 xmessage -geometry 600x250+80+100 "OpenCrane live desktop proof" >/dev/null 2>&1 &');
    app.get('/live-view-test', async (_request, reply) => reply.type('text/html').send(await readFile('apps/web/dist/live-view/browser/index.html')));
    app.get('/*', async (request, reply) => {
      const path = request.url.split('?')[0]!;
      if (!/^\/[\w./-]+$/u.test(path) || path.includes('..')) return reply.code(404).send();
      return reply.type(path.endsWith('.js') ? 'application/javascript' : path.endsWith('.css') ? 'text/css' : 'application/octet-stream')
        .send(await readFile(`apps/web/dist/live-view/browser${path}`));
    });
    const address = await app.listen({ host: '127.0.0.1', port });
    const cookie = encodeSession(config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+600 });
    const headers = { cookie: `${config.cookieName}=${cookie}`, origin: address, 'x-opencrane-view': '1' };
    const connect = async (custom = headers) => {
      const response = await app.inject({ method: 'POST', url: '/api/conversations/chat/view', headers: custom });
      expect(response.statusCode).toBe(200);
      const ticket = response.json<{ ticket: string; sessionId: string }>();
      const socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws/conversations/chat/view`, ['binary', ticket.ticket], { headers: custom });
      socket.on('error', () => undefined); return { socket, sessionId: ticket.sessionId };
    };
    const observed = await connect();
    const normal = await rfbViewer(observed.socket); expect(normal.first.pixels).toBe(480000);
    for (const bytes of [Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]), Buffer.from([5, 0, 0, 0, 80, 0, 80, 0, 0, 0, 0]),
      Buffer.from([180, 1, 10, ...Buffer.from('text/plain'), 10, 0, 0, 0, 65]), Buffer.from([6]), Buffer.from([7]),
      Buffer.from([255]), Buffer.from([2, 0, 1, 1]), Buffer.alloc(4097, 3)]) {
      const attacker = await rfbViewer((await connect()).socket), closed = once(attacker.socket, 'close');
      attacker.socket.send(bytes.subarray(0, 1), { fin: false }); attacker.socket.send(bytes.subarray(1), { fin: true });
      await closed; expect((await normal.refresh()).pixels).toBe(480000);
    }
    const slow = await connect(), stalled = await rfbViewer(slow.socket), stallClosed = once(stalled.socket, 'close');
    stalled.socket.pause();
    const rssBefore = process.memoryUsage().rss; let peakRss = rssBefore, slowStopped = false;
    const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
    try {
      for (let frame = 0; frame < 32; frame++) {
        if (!slowStopped) stalled.socket.send(stalled.request);
        expect((await normal.refresh()).pixels).toBe(480000);
        if (!slowStopped && (await history(fixture.nats.store, `view-${slow.sessionId}`, 'test')).length === 2) {
          slowStopped = true; stalled.socket.resume(); expect((await stallClosed)[0]).toBe(1013);
        }
      }
      expect(slowStopped).toBe(true); expect(peakRss - rssBefore).toBeLessThan(128 * 1024 * 1024);
    } finally { clearInterval(sample); stalled.socket.terminate(); }
    normal.socket.close();
    await until(async () => (await history(fixture.nats.store, `view-${observed.sessionId}`, 'test')).length === 2);
    const normalAudit = await history(fixture.nats.store, `view-${observed.sessionId}`, 'test');
    expect(normalAudit[0]?.event.principal).toEqual({ kind: 'human', id: 'alice' });
    expect(normalAudit[0]?.event.data).toMatchObject({ sessionId: observed.sessionId, memberId: 'alice', conversationId: 'chat', computerId: 'desktop', generation: 1 });
    expect(normalAudit[1]?.event.data).toMatchObject({ reason: 'disconnected' });
    const admission = (await app.inject({ method: 'POST', url: '/api/conversations/chat/view', headers })).json<{ ticket: string }>();
    const wrongOrigin = new WebSocket(`${address.replace('http:', 'ws:')}/ws/conversations/chat/view`, ['binary', admission.ticket], { headers: { ...headers, origin: 'https://wrong.test' } });
    wrongOrigin.on('error', () => undefined);
    expect(await new Promise<number | undefined>(resolve => wrongOrigin.on('unexpected-response', (_request, response) => { resolve(response.statusCode); wrongOrigin.terminate(); }))).toBe(403);
    const expiringHeaders = { ...headers, cookie: `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+5 })}` };
    const expiring = await connect(expiringHeaders), expired = once(expiring.socket, 'close');
    expect((await rfbViewer(expiring.socket)).first.pixels).toBe(480000); expect((await expired)[0]).toBe(4003);
    expect((await app.inject({ method: 'POST', url: '/api/conversations/chat/view', headers: expiringHeaders })).statusCode).toBe(403);

    const context = await browser.newContext();
    await context.addCookies([{ name: config.cookieName, value: cookie, url: address, httpOnly: true, sameSite: 'Lax' }]);
    const hashes = [];
    const browserErrors: string[] = [];
    for (const width of [1280, 390]) {
      const page = await context.newPage(); await page.setViewportSize({ width, height: 900 });
      page.on('pageerror', error => browserErrors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
      await page.goto(`${address}/live-view-test`);
      const button = page.getByRole('button', { name: 'Watch your computer', exact: true }); await button.focus(); await page.keyboard.press('Enter');
      await page.getByText('Viewing', { exact: true }).waitFor({ timeout: 20_000 }).catch(error => { throw new Error(JSON.stringify(browserErrors), { cause: error }); });
      const canvas = page.locator('canvas'); await until(async () => await canvas.evaluate((c: HTMLCanvasElement) => c.width === 800 && c.height === 600)).catch(async error => { throw new Error(JSON.stringify({ browserErrors, body: await page.locator('body').innerText(), canvases: await page.locator('canvas').evaluateAll(cs => cs.map(c => [c.getAttribute('width'), c.getAttribute('height')])) }), { cause: error }); });
      const neighbour = await rfbViewer((await connect()).socket); expect(neighbour.first.pixels).toBe(480000);
      neighbour.socket.close(); await once(neighbour.socket, 'close');
      await page.getByText('Viewing', { exact: true }).waitFor();
      const pixels = await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL());
      hashes.push(createHash('sha256').update(pixels).digest('hex'));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole('button', { name: 'Actual size · zoom' }).click(); await page.getByRole('button', { name: 'Fit', exact: true }).click();
      await page.screenshot({ path: `${output}/viewer-${width}.png`, fullPage: true });
      for (const button of await page.getByRole('button').all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      if (width === 390) {
        const revoked = performance.now();
        await append(grantStream('shared_desktop', 'desktop'), 'grant.revoked', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', revokedBy: 'owner' });
        await page.getByText('Access changed', { exact: true }).waitFor({ timeout: 2000 });
        expect(performance.now() - revoked).toBeLessThan(2000); expect(await page.locator('canvas').count()).toBe(0);
        await page.screenshot({ path: `${output}/access-changed-390.png` });
        await append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
      } else { await page.getByRole('button', { name: 'Close view' }).click(); await page.getByRole('dialog', { name: 'Computer view' }).waitFor({ state: 'hidden' }); }
      await page.close();
    }

    const ticket = (await app.inject({ method: 'POST', url: '/api/conversations/chat/view', headers })).json<{ ticket: string; sessionId: string }>();
    const ws = new WebSocket(`${address.replace('http:', 'ws:')}/ws/conversations/chat/view`, ['binary', ticket.ticket], { headers });
    ws.on('error', () => undefined); await once(ws, 'open');
    const closed = once(ws, 'close'), start = performance.now();
    await append(grantStream('shared_desktop', 'desktop'), 'grant.revoked', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', revokedBy: 'owner' });
    expect((await closed)[0]).toBe(4003); const revokedMs = performance.now() - start; expect(revokedMs).toBeLessThan(2000);
    await until(async () => (await history(fixture.nats.store, `view-${ticket.sessionId}`, 'test')).length === 2);
    expect(JSON.parse(await pod.k('get', 'pod/desktop', '-o', 'jsonpath={.status.containerStatuses[0].restartCount}'))).toBe(0);
    await writeFile(`${output}/receipt.json`, JSON.stringify({ date: new Date().toISOString(), image: pod.image, namespace: pod.namespace, hashes, revokedMs, framebuffer: normal.first, audit: normalAudit.map(({ sequence, event }) => ({ sequence, id: event.id, type: event.type, principal: event.principal, data: event.data })), slowViewer: { frames: 32, rssBefore, peakRss, code: 1013 }, expiry: 'PASS', wrongOrigin: 'PASS', directNetwork: 'PASS', serverReadOnly: 'PASS', protocolAttacks: 'PASS', status: 'PASS' }, null, 2));
  } finally {
    try { await closeBrowser?.(); } finally {
      try { await closeFixture?.(); } finally { await pod.close(); }
    }
  }
}, 240_000);
