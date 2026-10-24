export { freePort } from '@opencrane/event-store/testing';
import { freePort } from '@opencrane/event-store/testing';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { onTestFinished } from 'vitest';
import type { Db } from '@opencrane/projections';
import { startGateway } from '../src/gateway.ts';

export async function acquireGatewayTestLock(session: Pick<Db, 'query'>, lockName: string) {
  const acquired = await session.query<{ held: boolean }>(
    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS held', [lockName]);
  return acquired.rows[0]!.held;
}

export async function gatewayFixture() {
  const directory = await mkdtemp(`${tmpdir()}/gateway-reload-`);
  const pair = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  const jwks = JSON.stringify({ keys: [{ ...jwk, kid: 'fixture', alg: 'ES256' }] });
  const traffic: { path: string; headers: IncomingMessage['headers']; content: string }[] = [];
  async function serveKeys(request: IncomingMessage, response: ServerResponse) {
    if (request.url !== '/jwks.json') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        if (!Buffer.isBuffer(chunk)) throw new Error('Invalid fixture bytes');
        chunks.push(chunk);
      }
      traffic.push({ path: request.url!, headers: request.headers,
        content: Buffer.concat(chunks).toString() });
      response.setHeader('x-opencrane-mcp-permit', 'fixture-permit');
      response.setHeader('x-request-id', 'fixture');
      response.end('{}');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(jwks);
  }
  function serve(request: IncomingMessage, response: ServerResponse) {
    void serveKeys(request, response).catch(failed);
    function failed() {
      response.destroy();
    }
  }
  const decision = createServer(serve);
  decision.listen(0, '127.0.0.1');
  await once(decision, 'listening');
  const address = decision.address();
  if (!address || typeof address === 'string') {
    throw new Error('No fixture listener');
  }
  let child: ChildProcess | undefined;
  let stop: ((signal?: NodeJS.Signals) => Promise<void>) | undefined;
  const logs: string[] = [];
  function record(chunk: Buffer) {
    logs.push(chunk.toString('utf8'));
  }
  function spawned(process: ChildProcess, stopProcess: NonNullable<typeof stop>) {
    child = process;
    stop = stopProcess;
    process.stdout?.on('data', record);
    process.stderr?.on('data', record);
  }
  async function close() {
    await stop?.('SIGKILL');
    const closed = once(decision, 'close');
    decision.close();
    decision.closeAllConnections();
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
  onTestFinished(close);
  let port = await freePort();
  let readinessPort = await freePort();
  const options = {
    binary: resolve('spikes/s0-1c-real-model-smoke/.tools/agentgateway-linux-amd64'),
    configFile: `${directory}/gateway.json`, usageFile: `${directory}/usage.jsonl`,
    keyFile: `${directory}/provider`, port, readinessPort,
    decisionUrl: `http://127.0.0.1:${address.port}`, issuer: 'reload-fixture',
    onChildSpawn: spawned,
  };
  await writeFile(options.keyFile, 'KEY-FILE-CANARY', { mode: 0o600 });
  let gateway: Awaited<ReturnType<typeof startGateway>>;
  for (let attempt = 0; ; attempt++) {
    try {
      gateway = await startGateway(options);
      break;
    } catch (error) {
      const addressInUse = error instanceof Error &&
        /address (?:already )?in use/iu.test(error.message);
      if (!addressInUse || attempt >= 2) throw error;
      port = await freePort();
      readinessPort = await freePort();
      options.port = port;
      options.readinessPort = readinessPort;
    }
  }
  const signer = new SignJWT({});
  signer.setProtectedHeader({ alg: 'ES256', kid: 'fixture' });
  signer.setIssuer(options.issuer);
  signer.setAudience('agentgateway');
  signer.setExpirationTime('5m');
  const pass = await signer.sign(pair.privateKey);
  return { options, gateway, child: child!, logs, traffic, pass };
}
