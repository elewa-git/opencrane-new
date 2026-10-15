import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { until } from '@opencrane/authz/testing';
import { fixture } from './fixture.ts';

it('sends only the decision key on each AI call and keeps native token counts', async () => {
  const setup = await fixture();
  const paths: string[] = [];
  let current = 'managed-first-fixture-value';
  let reservation = randomUUID();
  function decide(request: IncomingMessage, response: ServerResponse) {
    request.resume();
    if (request.url === '/jwks.json') {
      response.end(JSON.stringify(setup.identity.jwks));
      return;
    }
    paths.push(request.url ?? '');
    response.setHeader('x-provider-key', current);
    response.setHeader('x-reservation-id', reservation);
    response.setHeader('x-request-id', reservation);
    response.end('{}');
  }
  const decision = createServer(decide);
  decision.listen(0, '127.0.0.1');
  await once(decision, 'listening');
  const address = decision.address();
  if (!address || typeof address === 'string') throw new Error('No decision address');
  const managed = { managedCalls: true, decisionUrl: `http://127.0.0.1:${address.port}` };
  Object.assign(setup.options, managed);
  try {
    await setup.restart();
    for (const value of ['managed-first-fixture-value', 'managed-second-fixture-value']) {
      current = value;
      reservation = randomUUID();
      const injection = { 'x-provider-key': 'caller-fixture-value' };
      const response = await setup.call(injection);
      expect(response.status).toBe(200);
      const hash = createHash('sha256');
      hash.update(`Bearer ${value}`);
      expect(setup.providerAuthHash()).toBe(hash.digest('hex'));
      expect(setup.providerHeaders()).not.toContain('x-provider-key');
      expect(setup.providerHeaders()).not.toContain('x-turn-token');
      expect(response.text).not.toContain(value);
      async function usageArrived() {
        const usage = await readFile(setup.options.usageFile, 'utf8');
        return usage.includes(reservation);
      }
      await until(usageArrived);
    }
    expect(paths).toEqual(['/authorize/models/managed', '/authorize/models/managed']);
    const usage = await readFile(setup.options.usageFile, 'utf8');
    expect(usage).toContain('"inputTokens":1000');
    expect(usage).toContain('"outputTokens":120');
    expect(usage).not.toContain('fixture-value');
  } finally {
    await setup.close();
    decision.closeAllConnections();
    await new Promise<void>(function close(resolve) { decision.close(() => resolve()); });
  }
}, 40_000);
