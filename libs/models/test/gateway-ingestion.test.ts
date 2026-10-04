import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startGateway } from '../src/index.ts';

const subprocess = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: subprocess.spawn }));
afterEach(() => { vi.unstubAllGlobals(); });

it('drains observations emitted after process exit before completing gateway shutdown', async () => {
  const directory = await mkdtemp(`${tmpdir()}/gateway-drain-`);
  const traffic = createServer(socket => socket.end());
  traffic.listen(0, '127.0.0.1'); await once(traffic, 'listening');
  const address = traffic.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const line = (id: string) => `http.status=403 decisionRequestId="${id}"\n`;
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null,
    kill(): boolean {
      this.exitCode = 0;
      child.emit('exit', 0);
      // An exited OS process may still have unread bytes in its stdout pipe.
      setTimeout(() => { this.stdout.end(line(ids[1]!)); this.stderr.end(); child.emit('close', 0); }, 50);
      return true;
    },
  });
  subprocess.spawn.mockReturnValue(child);
  vi.stubGlobal('fetch', async (url: string) => new Response(url.endsWith('/api/config/effective')
    ? await readFile(`${directory}/config.json`, 'utf8') : url.endsWith('/config_dump') ? '{"binds":[],"backends":[]}' : '{}'));
  try {
    await writeFile(`${directory}/key`, 'fixture-only');
    const gateway = await startGateway({ binary: resolve('spikes/s0-1c-real-model-smoke/.tools/agentgateway-linux-amd64'),
      configFile: `${directory}/config.json`, usageFile: `${directory}/usage.jsonl`, keyFile: `${directory}/key`,
      port: address.port, readinessPort: 12346, decisionUrl: 'http://127.0.0.1:12347', issuer: 'https://fixture.test/' });
    child.stdout.write(line(ids[0]!));
    await vi.waitFor(async () => { expect(await readFile(`${directory}/usage.jsonl`, 'utf8')).toContain(ids[0]); });
    await gateway.stop();
    const saved = (await readFile(`${directory}/usage.jsonl`, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as unknown);
    expect(saved).toEqual(ids.map(id => ({ id, outcome: 'error', reason: 'dispatch_denied' })));
  } finally {
    await new Promise<void>(resolve => traffic.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
