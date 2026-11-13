import { expect, it } from 'vitest';
import { mcpServerDiscoveredDataSchema } from '@opencrane/events';
import { isOrdinaryToolCatalogue } from '@opencrane/protocol';
import { losslessJson } from '@opencrane/events/lossless-json';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { readToolPolicy } from '@opencrane/models';
import { ordinaryRemoteFixture, permit, send, body }
  from '@opencrane/models/testing/mcp-dispatch';
import { discoverInventory } from '../src/integrations/inventory.ts';
import { captureCatalogue, ordinaryWrite, rejectedSibling } from './support/ordinary-catalogue.ts';

async function refusesMixedCatalogue() {
  const paid = { ...rejectedSibling, name: 'paid', inputSchema: { type: 'object' },
    _meta: { 'io.opencrane/costCents': 1 } };
  const inventory = await captureCatalogue([ordinaryWrite, paid]);
  const { setup, headers, remote } = await ordinaryRemoteFixture('allow', undefined, inventory);
  const request = { method: 'POST', headers, body };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    request);
  expect(response.status).toBe(403);
  expect(remote.calls).toEqual([]);
  expect(isOrdinaryToolCatalogue(inventory)).toBe(false);
}
it('refuses dispatch for an ordinary write beside a rejected paid declaration', refusesMixedCatalogue);

async function checksCompleteCatalogue(change: 'unchanged' | 'added' | 'removed' | 'schema' |
  'annotation') {
  const definitions = [ordinaryWrite, rejectedSibling];
  const inventory = await captureCatalogue(definitions);
  const { setup, headers, remote } = await ordinaryRemoteFixture('allow', undefined, inventory);
  const current: unknown[] = [...definitions];
  if (change === 'added') current.push({ ...ordinaryWrite, name: 'another' });
  if (change === 'removed') current.pop();
  if (change === 'schema') current[0] = { ...ordinaryWrite,
    inputSchema: { type: 'object', properties: { note: { type: 'string' } } } };
  if (change === 'annotation') current[0] = { ...ordinaryWrite,
    annotations: { readOnlyHint: true } };
  function respond(method: string) {
    if (method === 'tools/list') return { tools: current };
    return { content: [] };
  }
  remote.respond(respond);
  const value = await permit(setup, headers);
  const response = await send(setup, value);
  expect(response.status, await response.clone().text()).toBe(200);
  const policy = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  function method(call: { method: string }) { return call.method; }
  if (change === 'unchanged') {
    expect(remote.calls.map(method)).toEqual(['tools/list', 'tools/call']);
    expect(policy.driftHeld).toBe(false);
  } else {
    expect(await response.json()).toMatchObject({ result: { isError: true,
      content: [{ text: 'The tool list changed. An admin must review it before another call.' }] } });
    expect(remote.calls.map(method)).toEqual(['tools/list']);
    expect(policy.driftHeld).toBe(true);
  }
  const fullRevisions = definitions.map(revision);
  expect(inventory.schemaDigest).toBe(catalogueDigest(fullRevisions));
  mcpServerDiscoveredDataSchema.parse(inventory);
}
function revision(definition: unknown) {
  const encoded = losslessJson(JSON.stringify(definition));
  const name = encoded.value instanceof Map ? encoded.value.get('name')?.value : undefined;
  if (typeof name !== 'string') throw new Error('Expected named fixture tool');
  return { name, revision: encoded.digest };
}
it.each(['unchanged', 'added', 'removed', 'schema', 'annotation'] as const)(
  'checks the complete discovered catalogue before dispatch: %s', checksCompleteCatalogue);
