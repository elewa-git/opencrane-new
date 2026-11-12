import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { freePort } from '@opencrane/event-store/testing';
import { until } from '@opencrane/authz/testing';
import { onTestFinished } from 'vitest';

export type CredentialDemoAccounts = readonly [
  { account: string; key: string; permitted: true },
  { account: string; key: string; permitted: false },
];

/** Run the actual other application as a service rather than importing its source. */
export async function credentialDemo(accounts: CredentialDemoAccounts) {
  const directory = await mkdtemp(`${tmpdir()}/personal-key-demo-`);
  const file = `${directory}/accounts.json`;
  await writeFile(file, JSON.stringify(accounts), { mode: 0o600 });
  const port = await freePort();
  const env = { PATH: process.env['PATH'], PORT: String(port), DEMO_ACCOUNTS_FILE: file };
  const child = spawn(process.execPath,
    ['--experimental-strip-types', 'apps/demo-mcp/src/main.ts'], { env, stdio: 'ignore' });
  const exited = once(child, 'exit');
  async function close() {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
  onTestFinished(close);
  async function ready() {
    if (child.exitCode !== null) throw new Error('Demo tool process stopped');
    try {
      const reply = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'mcp-method': 'tools/list',
          'mcp-protocol-version': '2026-07-28' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'ready', method: 'tools/list',
          params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }) });
      return reply.ok;
    } catch {
      return false;
    }
  }
  await until(ready);
  function forward(incoming: IncomingMessage, response: ServerResponse) {
    function received(upstream: IncomingMessage) {
      response.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(response);
    }
    const outgoing = request({ host: '127.0.0.1', port, path: '/',
      method: incoming.method, headers: incoming.headers }, received);
    function failed() {
      outgoing.destroy();
      response.destroy();
    }
    outgoing.on('error', failed);
    incoming.on('error', failed);
    incoming.pipe(outgoing);
  }
  return forward;
}
