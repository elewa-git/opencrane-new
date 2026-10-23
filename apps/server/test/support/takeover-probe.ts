import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { WebSocketServer } from 'ws';
import { onTestFinished, vi } from 'vitest';
import { tokenIssuer } from '@opencrane/auth';
import type { ChatOptions } from '../../src/chat/access.ts';
import { connectBridge } from '../../src/chat/bridge.ts';

export async function takeoverProbe(options: ChatOptions) {
  const directory = await mkdtemp(`${tmpdir()}/takeover-refusal-`);
  async function removeDirectory() { await rm(directory, { recursive: true, force: true }); }
  onTestFinished(removeDirectory);
  const keyOptions = { namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } } as const;
  const pair = generateKeyPairSync('ec', keyOptions);
  const privateKeyPath = `${directory}/key.pem`;
  await writeFile(privateKeyPath, pair.privateKey, { mode: 0o600 });
  const issuerOptions = { privateKeyPath, issuer: 'https://bridge.test/' };
  const tokens = await tokenIssuer(issuerOptions);
  const gate = vi.spyOn(tokens, 'takeoverGate');
  const serverOptions = { port: 0, host: '127.0.0.1' };
  const server = new WebSocketServer(serverOptions);
  async function closeServer() {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(close);
    function close(resolve: () => void) { server.close(resolve); }
  }
  onTestFinished(closeServer);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing bridge address');
  function unexpectedStop(): Promise<never> {
    return Promise.reject(new Error('Unexpected executor stop'));
  }
  const stopExecution = vi.fn(unexpectedStop);
  const bridgeOptions = { ...options, stopExecution };
  const input = { url: `ws://127.0.0.1:${address.port}`, computerId: 'desktop',
    assistantId: 'assistant', bearer: 'test' };
  const link = await connectBridge(bridgeOptions, input, tokens);
  async function closeLink() {
    link.socket.terminate();
    await link.settled();
  }
  onTestFinished(closeLink);
  await link.control.send();
  const send = vi.spyOn(link.socket, 'send');
  return { control: link.control, gate, send, stopExecution };
}
