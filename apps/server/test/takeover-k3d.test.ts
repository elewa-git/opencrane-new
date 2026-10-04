/// <reference lib="dom" />
import { once } from 'node:events';
import { z } from 'zod';
import { it, expect } from 'vitest';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { encodeSession } from '@opencrane/auth';
import { grantStream } from '@opencrane/authz';
import { desktopPod } from './support/desktop-pod.ts';
import { viewFixture } from './support/view-fixture.ts';
import { desktopConnection } from '../src/computers/desktop.ts';

it.runIf(process.env['TAKEOVER_K3D'] === '1')('takes and releases real desktop input with keyboard and 44px controls at 1280 and 390px', async () => {
  const pod = await desktopPod();
  const browser = await chromium.launch({ headless: true });
  let fixture: Awaited<ReturnType<typeof viewFixture>> | undefined;
  try {
    const { createServer } = await import('node:net');
    const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const bound = reservation.address(); if (!bound || typeof bound === 'string') throw new Error('No port');
    const port = bound.port; await new Promise<void>(resolve => reservation.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    fixture = await viewFixture(desktopConnection(pod.kubeconfig, pod.namespace), `${origin}/auth/callback`, async () => {});
    await fixture.append('computer-assistant', 'computer.ready', { assistantId: 'assistant', computerId: 'desktop', generation: 1, podUid: pod.uid });
    fixture.keys.provision('test', 'chat');
    await fixture.append('conversation-chat', 'message.posted', { conversationId: 'chat', authorId: 'alice', authorKind: 'human', contentType: 'text', ...fixture.keys.encrypt('test', 'chat', 'Help me log in') });
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
    fixture.app.get('/live-view-test', async (_req, reply) => reply.type('text/html').send(await readFile('apps/web/dist/live-view/browser/index.html')));
    fixture.app.get('/*', async (request, reply) => {
      const path = request.url.split('?')[0]!;
      if (!/^\/[\w.-]+$/u.test(path)) return reply.code(404).send();
      return reply.type(path.endsWith('.js') ? 'application/javascript' : path.endsWith('.css') ? 'text/css' : 'application/octet-stream').send(await readFile(`apps/web/dist/live-view/browser${path}`));
    });
    await fixture.app.listen({ port, host: '127.0.0.1' });
      const context = await browser.newContext();
      await context.addCookies([{ name: fixture.config.cookieName, value: encodeSession(fixture.config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+600 }), url: origin }]);
      const page = await context.newPage(); await mkdir('apps/computer/.state/p317', { recursive: true });
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 }); await page.goto(`${origin}/live-view-test`);
        await page.getByRole('button', { name: 'Watch your computer' }).click();
        await page.getByText('Viewing', { exact: true }).waitFor();
        const take = page.getByRole('button', { name: 'Take control', exact: true });
        await take.waitFor({ timeout: 10000 }).catch(async (cause: unknown) => { throw new Error(`Missing control at ${width}: ${await page.locator('body').innerText()}`, { cause }); });
        await take.focus(); await page.keyboard.press('Enter'); await page.getByText('You are in control', { exact: true }).waitFor();
        for (const name of ['Release', 'Renew control']) {
          const box = await page.getByRole('button', { name, exact: true }).boundingBox(); expect(box?.height).toBeGreaterThanOrEqual(44); expect(box?.width).toBeGreaterThanOrEqual(44);
        }
        const canvas = page.locator('canvas'); const bounds = await canvas.boundingBox();
        if (!bounds) throw new Error('No computer pixels');
        await page.mouse.click(bounds.x + bounds.width / 4, bounds.y + bounds.height / 4);
        const pointer = await pod.k('exec', 'desktop', '--', 'env', 'DISPLAY=:1', 'xdotool', 'getmouselocation');
        expect(pointer).toMatch(/x:19[89]|x:20[01]/u);
        await page.screenshot({ path: `apps/computer/.state/p317/control-${width}.png` });
        const release = page.getByRole('button', { name: 'Release', exact: true }); await release.focus();
        const released = page.waitForResponse(response => response.url().endsWith('/control') && response.request().postData()?.includes('release') === true);
        await page.keyboard.press('Enter'); expect((await released).status()).toBe(200);
        await page.getByRole('button', { name: 'Take control', exact: true }).waitFor();
        await page.getByText('Viewing', { exact: true }).waitFor();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.keyboard.press('Escape');
      }
      await context.close();
  } finally { await fixture?.close(); await browser.close(); await pod.close(); }
}, 180000);

it.runIf(process.env['TAKEOVER_K3D'] === '1')('quiesces two real Codex threads and a running isolated tool, then resumes fresh checked turns after release', async () => {
  const { spawn } = await import('node:child_process');
  const { createInterface } = await import('node:readline');
  const { generateKeyPairSync, randomUUID } = await import('node:crypto');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { tokenIssuer } = await import('@opencrane/auth');
  const { history } = await import('@opencrane/models');
  const { until } = await import('@opencrane/authz/testing');
  const { watchBridges } = await import('../src/chat/bridge.ts');
  const { SandboxClient } = await import('../../ops/src/kubernetes.ts');
  const { computerControl } = await import('../src/computers/desktop.ts');
  const { WebSocket } = await import('ws');
  const { rfbViewer } = await import('./support/rfb-viewer.ts');
  const pod = await desktopPod(true), directory = await mkdtemp(`${tmpdir()}/takeover-live-`);
  let fixture: Awaited<ReturnType<typeof viewFixture>> | undefined;
  let proxy: ReturnType<typeof spawn> | undefined, work: Promise<void> | undefined;
  const stop = new AbortController(); let writer: InstanceType<typeof WebSocket> | undefined;
  try {
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    await writeFile(`${directory}/key`, key.privateKey, { mode: 0o600 });
    const tokens = await tokenIssuer({ privateKeyPath: `${directory}/key`, issuer: 'https://takeover.test/' });
    fixture = await viewFixture(desktopConnection(pod.kubeconfig, pod.namespace), undefined, computerControl(pod.kubeconfig, pod.namespace));
    const f = fixture;
    await f.append('computer-assistant', 'computer.ready', { assistantId: 'assistant', computerId: 'desktop', generation: 1, podUid: pod.uid });
    await f.append('budget-test', 'budget.ceiling_set', { scope: 'global', ceilingCents: 20000, dailyCeilingCents: 2000, defaultPayingGroupId: 'personal-default', setBy: 'owner' });
    await f.append('conversation-other', 'conversation.created', { conversationId: 'other', assistantId: 'assistant', createdBy: 'alice', mode: 'agent_session' }, true);
    for (const conversation of ['chat', 'other']) {
      f.keys.provision('test', conversation);
      await f.append(`conversation-${conversation}`, 'message.posted', { conversationId: conversation, authorId: 'alice', authorKind: 'human', contentType: 'text', ...f.keys.encrypt('test', conversation, conversation === 'chat' ? 'ISOLATION: run the local tool.' : 'KILL_ME: keep working until takeover.') });
    }
    await f.projectConversations();
    await f.append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
    await pod.k('exec', 'desktop', '--', 'node', '--input-type=module', '-e', `import {writeFileSync} from 'node:fs'; writeFileSync('/workspace/probe.mjs', "import {writeFileSync} from 'node:fs'; writeFileSync('/workspace/tool-started',JSON.stringify({uid:process.getuid(),pid:process.pid})); setInterval(()=>{},1000);", {mode:0o644});`);
    proxy = spawn('kubectl', ['--kubeconfig', pod.kubeconfig, 'proxy', '--port=0', '--address=127.0.0.1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const url = await new Promise<string>((resolve, reject) => { proxy!.once('error', reject); createInterface({ input: proxy!.stdout! }).on('line', line => { const port = /127\.0\.0\.1:(\d+)/u.exec(line)?.[1]; if (port) resolve(`http://127.0.0.1:${port}`); }); });
    work = watchBridges(f.chat, tokens, new SandboxClient(pod.kubeconfig, pod.namespace), url, stop.signal);
    void work.catch(() => stop.abort());
    await until(async () => { try { return (await pod.k('exec', 'desktop', '--', 'cat', '/workspace/tool-started')).includes('"uid":1001'); } catch { return false; } }, 60000);
    await until(async () => (await history(f.nats.store, 'computer-assistant', 'test')).filter(r => r.event.type === 'computer.turn_started').length === 2, 30000);
    const headers = { origin: new URL(f.config.redirectUri).origin, 'x-opencrane-view': '1', cookie: `${f.config.cookieName}=${encodeSession(f.config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+600 })}` };
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const result = await f.app.inject({ method: 'POST', url: '/api/conversations/chat/control', headers });
    expect({ status: result.statusCode, events: (await history(f.nats.store, 'computer-assistant', 'test')).map(r => r.event.type) }).toMatchObject({ status: 200 });
    const lease = result.json<{ ticket: string; leaseId: string }>();
    const paused = await history(f.nats.store, 'computer-assistant', 'test');
    expect(paused.filter(r => r.event.type === 'computer.turn_closed')).toHaveLength(2);
    expect(z.object({ affectedTurns: z.array(z.object({ conversationId: z.string() })) }).parse(paused.at(-1)?.event.data).affectedTurns.map(t => t.conversationId).sort()).toEqual(['chat', 'other']);
    const processes = await pod.k('exec', 'desktop', '--', 'node', '--input-type=module', '-e', String.raw`import{readdirSync,readFileSync}from'node:fs';console.log(readdirSync('/proc').filter(p=>/^\d+$/.test(p)).filter(p=>{try{const s=readFileSync('/proc/'+p+'/status','utf8');return /^Uid:\s+1001\s/m.test(s)&&!/^State:\s+Z/m.test(s)}catch{return false}}).length)`);
    expect(processes).toBe('0');
    writer = new WebSocket(`${address.replace('http:', 'ws:')}/ws/conversations/chat/control`, ['binary', lease.ticket], { headers }); writer.on('error', () => undefined);
    const desktop = await rfbViewer(writer).catch(async (cause: unknown) => { throw new Error(`Writer closed: ${JSON.stringify((await history(f.nats.store, 'computer-assistant', 'test')).at(-1)?.event.data)}; Pod ${await pod.k('get', 'pod/desktop', '-o', 'jsonpath={.status.containerStatuses[0].restartCount}')}`, { cause }); }); expect(desktop.first.pixels).toBe(480000);
    writer.send(Buffer.from([5, 0, 0, 150, 0, 150]));
    await until(async () => (await pod.k('exec', 'desktop', '--', 'env', 'DISPLAY=:1', 'xdotool', 'getmouselocation')).includes('x:150 y:150'));
    const closed = once(writer, 'close');
    expect((await f.app.inject({ method: 'POST', url: '/api/conversations/chat/control', headers, payload: { action: 'release', leaseId: lease.leaseId } })).statusCode).toBe(200);
    await closed;
    await until(async () => (await history(f.nats.store, 'computer-assistant', 'test')).filter(r => r.event.type === 'computer.turn_started').length === 4, 30000);
    const resumed = await history(f.nats.store, 'computer-assistant', 'test');
    expect(new Set(resumed.filter(r => r.event.type === 'computer.turn_started').map(r => z.object({ turnId: z.string() }).parse(r.event.data).turnId)).size).toBe(4);
    // A new proxy instance must recover each durable crash boundary against the real restarted computer.
    const { takeover } = await import('../src/computers/takeover.ts');
    const control = computerControl(pod.kubeconfig, pod.namespace), kube = new SandboxClient(pod.kubeconfig, pod.namespace);
    const computer = { assistantId: 'assistant', computerId: 'desktop', generation: 1, podUid: pod.uid };
    for (const transition of ['takeover.requested', 'takeover.started', 'takeover.renewed']) {
      const conversation = await history(f.nats.store, 'conversation-chat', 'test');
      const data = { ...computer, requestedBy: 'alice', conversationId: 'chat', turnId: conversation.findLast(r => r.event.type === 'message.posted')!.event.id,
        leaseId: randomUUID(), expiresAt: new Date(Date.now() + 120000).toISOString(), affectedTurns: [] };
      await f.append('computer-assistant', 'takeover.requested', data);
      if (transition !== 'takeover.requested') {
        await control(computer, 'pause', data.leaseId); await f.append('computer-assistant', 'takeover.started', data);
        if (transition === 'takeover.renewed') await f.append('computer-assistant', transition, data);
      }
      const count = Number(await pod.k('get', 'pod/desktop', '-o', 'jsonpath={.status.containerStatuses[0].restartCount}'));
      await pod.k('exec', 'desktop', '--', 'node', '-e', "process.kill(1,'SIGTERM')").catch(() => undefined);
      await until(async () => Number(await pod.k('get', 'pod/desktop', '-o', 'jsonpath={.status.containerStatuses[0].restartCount}')) > count, 60000);
      await pod.k('wait', '--for=condition=Ready', 'pod/desktop', '--timeout=120s');
      await kube.credentials('desktop', await tokens.computer({ silo: 'test', ...computer, tokenId: 'token:test' }), true);
      const recovery = takeover({ ...f.chat, open: desktopConnection(pod.kubeconfig, pod.namespace), control });
      await recovery.reconcile();
      const recovered = (await history(f.nats.store, 'computer-assistant', 'test')).at(-1)!.event;
      expect(recovered).toMatchObject({ type: 'takeover.ended', data: { reason: 'crash', leaseId: data.leaseId } });
      expect(await pod.k('exec', 'desktop', '--', 'cat', '/home/agent/codex/bridge-reports.jsonl.paused')).toBe(data.leaseId);
      await expect(recovery.check('alice', 'chat', data.leaseId)).rejects.toThrow();
      await recovery.release('alice', 'chat', data.leaseId); await control(computer, 'resume', data.leaseId); await recovery.close();
    }

  } finally {
    writer?.terminate(); stop.abort(); await work;
    proxy?.kill(); await fixture?.close(); await pod.close(); await rm(directory, { recursive: true, force: true });
  }
}, 420000);
