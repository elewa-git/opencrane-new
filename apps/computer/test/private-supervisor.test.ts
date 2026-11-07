import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { supervisePrivateChild } from '../src/private-supervisor.ts';

it('waits for process exit when the child closes stdout but keeps running', async () => {
  const home = mkdtempSync(`${tmpdir()}/private-supervisor-`);
  const server = createServer({ allowHalfOpen: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test socket');
  const accepted = once(server, 'connection');
  const peer = connect({ host: '127.0.0.1', port: address.port, allowHalfOpen: true });
  const [supervisorSocket] = await accepted as [Socket];
  const child = spawn(process.execPath, ['-e',
    'process.stdout.end(); setInterval(() => {}, 1000);'],
  { stdio: ['pipe', 'pipe', 'ignore'] });
  const children = new Set([child]);
  try {
    supervisePrivateChild(child, supervisorSocket, home, children);
    await vi.waitFor(() => expect(child.stdout?.readableEnded).toBe(true));
    expect(child.exitCode).toBeNull();
    expect(children.has(child)).toBe(true);
    expect(existsSync(home)).toBe(true);
    expect(peer.readableEnded).toBe(false);

    const ended = once(peer, 'end');
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    await ended;
    expect(children.has(child)).toBe(false);
    expect(existsSync(home)).toBe(false);
  } finally {
    child.kill('SIGKILL');
    peer.destroy();
    supervisorSocket.destroy();
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
