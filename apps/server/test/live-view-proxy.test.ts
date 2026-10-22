import { freePort } from '@opencrane/event-store/testing';
import { nextBinaryMessage } from './support/rfb-viewer.ts';
import { grantStream } from '@opencrane/authz';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough, Duplex } from 'node:stream';
import { expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { encodeSession } from '@opencrane/auth';
import { until } from '@opencrane/authz/testing';
import { history } from '@opencrane/models';
import { viewFixture } from './support/view-fixture.ts';
import { attachWebSocketServer } from '../src/websocket.ts';

it.each(['web', 'dev-stack'])('opens the viewer through the configured %s frontend proxy', async source => {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const directory = await mkdtemp(`${tmpdir()}/view-proxy-`), sockets: WebSocket[] = [];
  const fixture = await viewFixture(() => {
    const readable = new PassThrough(), writable = new PassThrough(); writable.resume();
    readable.write(Buffer.from('RFB 003.008\n'));
    return Promise.resolve(Duplex.from({ readable, writable }));
  }, `${origin}/auth/callback`);
  const realtime = attachWebSocketServer(fixture.app.server, fixture.app.log, fixture.config);
  let frontend: ChildProcess | undefined, output = '';
  try {
    const backend = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    let proxy = `${directory}/proxy.json`;
    if (source === 'web') {
      const config = z.record(z.string(), z.object({ target: z.string(), changeOrigin: z.boolean(), secure: z.boolean(), ws: z.boolean().optional() })).parse(JSON.parse(await readFile('apps/web/proxy.conf.json', 'utf8')) as unknown);
      for (const route of Object.values(config)) route.target = backend;
      await writeFile(proxy, JSON.stringify(config));
    } else {
      // Generate in a disposable directory; never read or write the shared stack's files.
      await promisify(execFile)('node', ['--experimental-strip-types', '--input-type=module', '-e',
        "import { prepareDirectory, generate, save } from './infra/dev-stack/config.ts'; import { readFile } from 'node:fs/promises'; await prepareDirectory(); await save('zitadel-client-secret', 'test-only'); await generate(JSON.parse(await readFile('infra/dev-stack/zitadel.json', 'utf8')).origin);"],
      { env: { ...process.env, DEV_STACK_DIR: `${directory}/stack`, SERVER_PORT: new URL(backend).port } });
      proxy = `${directory}/stack/proxy.json`;
    }
    // Exercise the coloured ready output emitted on hosted runners.
    frontend = spawn('node', ['../../node_modules/@angular/cli/bin/ng.js', 'serve', '--host=127.0.0.1', `--port=${port}`, `--proxy-config=${proxy}`, '--watch=false', '--prebundle=false'], { cwd: 'apps/web', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '', FORCE_COLOR: '1' } });
    frontend.stdout?.on('data', (bytes: Buffer) => { output += bytes.toString(); });
    frontend.stderr?.on('data', (bytes: Buffer) => { output += bytes.toString(); });
    await until(async () => {
      if (frontend?.exitCode !== null) throw new Error(`Frontend exited: ${output}`);
      try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; }
      catch { return false; }
    }, 90_000).catch((cause: unknown) => { throw new Error(`Frontend did not become ready: ${output}`, { cause }); });
    await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', { resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice', granteeKind: 'member', grantedBy: 'owner' }, true);
    const cookie = encodeSession(fixture.config, { sub: 'alice', orgId: 'org-test', roles: [], authTime: 1, exp: Math.floor(Date.now()/1000)+120 });
    const headers = { origin, cookie: `${fixture.config.cookieName}=${cookie}`, 'x-opencrane-view': '1' };
    const response = await fetch(`${origin}/api/conversations/chat/view`, { method: 'POST', headers });
    expect(response.status).toBe(200);
    const { ticket, sessionId } = z.object({ ticket: z.string(), sessionId: z.string() }).parse(await response.json() as unknown);
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/ws/conversations/chat/view`, ['binary', ticket], { headers, handshakeTimeout: 2000 });
    sockets.push(socket); socket.on('error', () => undefined);
    expect(await nextBinaryMessage(socket)).toEqual(Buffer.from('RFB 003.008\n'));
    const closed = once(socket, 'close'); socket.close(); await closed;
    await until(async () => (await history(fixture.nats.store, `view-${sessionId}`, 'test')).length === 2);
    expect((await history(fixture.nats.store, `view-${sessionId}`, 'test')).map(row => row.event.type)).toEqual(['computer.view_started', 'computer.view_stopped']);
    const general = new WebSocket(`${origin.replace('http:', 'ws:')}/ws`, { headers, handshakeTimeout: 2000 });
    sockets.push(general); general.on('error', () => undefined);
    await once(general, 'open');
    const reply = once(general, 'message'); general.send(JSON.stringify({ type: 'hello', text: 'through frontend' }));
    expect(JSON.parse(String((await reply)[0])) as unknown).toMatchObject({ type: 'hello', text: 'through frontend' });
  } finally {
    for (const socket of sockets) socket.terminate();
    if (frontend && frontend.exitCode === null) { const exited = once(frontend, 'exit'); frontend.kill(); await exited; }
    await new Promise<void>(resolve => realtime.close(() => resolve()));
    await fixture.close(); await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
