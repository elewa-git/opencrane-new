import type { IncomingHttpHeaders } from 'node:http';
import { expect } from 'vitest';
import { body, selectedPersonalFixture } from './mcp-dispatch-fixture.ts';
import { personalPair } from './personal-dispatch.ts';

function expectedPersonalRequest(order: string, authorization: string) {
  const metadata = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  const toolArguments = { order, note: 'Deliver 1.0 pallets' };
  const params = { name: 'write', arguments: toolArguments, _meta: metadata };
  const body = { jsonrpc: '2.0', id: 2, method: 'tools/call', params };
  return { authorization, body };
}

function observedPersonalRequest(received: { raw: Buffer; headers: IncomingHttpHeaders }) {
  const body: unknown = JSON.parse(received.raw.toString());
  return { authorization: received.headers.authorization, body };
}

export function expectPersonalRequests(received: { raw: Buffer; headers: IncomingHttpHeaders }[]) {
  const observed = received.map(observedPersonalRequest);
  const alice = expectedPersonalRequest('SO-1042', 'Bearer alice-access');
  const bob = expectedPersonalRequest('SO-BOB', 'Bearer bob-access');
  expect(observed).toHaveLength(2);
  expect(observed).toEqual(expect.arrayContaining([alice, bob]));
}

export async function distinctPersonalTurns() {
  const context = await selectedPersonalFixture();
  const pair = await personalPair(context, body);
  // Distinguish calls by business data because private thread metadata never leaves the server.
  pair.bob.body = pair.bob.body.replace('SO-1042', 'SO-BOB');
  expect(pair.bob.body).toContain('SO-BOB');
  return pair;
}
