import { expect, it } from 'vitest';
import { mcpServerDiscoveredDataSchema } from '@opencrane/events';
import { isOrdinaryToolCatalogue } from '@opencrane/protocol';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { event } from '@opencrane/event-store/testing';
import { readToolPolicy } from '@opencrane/models';
import { ordinaryRemoteFixture, permit, send, body,
  reviewRestoration, publishRestoration, restorationDelivery, generationHeaders }
  from '@opencrane/models/testing/mcp-dispatch';
import { captureCatalogue, ordinaryWrite, rejectedSibling, revision } from './support/ordinary-catalogue.ts';

async function refusesMixedCatalogue() {
  const paid = { ...rejectedSibling, name: 'paid', inputSchema: { type: 'object' },
    _meta: { 'io.opencrane/costCents': 1 } };
  const inventory = await captureCatalogue([ordinaryWrite, paid]);
  const { setup, headers, remote, reviewResult } =
    await ordinaryRemoteFixture('allow', undefined, inventory);
  const request = { method: 'POST', headers, body };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    request);
  expect(response.status).toBe(403);
  expect(remote.calls).toEqual([]);
  expect(reviewResult.status).toBe('conflict');
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

it.each(['unchanged', 'added', 'removed', 'schema', 'annotation'] as const)(
  'checks the complete discovered catalogue before dispatch: %s', checksCompleteCatalogue);

async function refusesDowngradeThenSiblingRemoval() {
  const inventory = await captureCatalogue([ordinaryWrite, rejectedSibling]);
  const { setup, headers, remote } = await ordinaryRemoteFixture('allow', undefined, inventory);
  const downgraded = { ...inventory, schemaDigest: catalogueDigest(inventory.tools!) };
  Reflect.deleteProperty(downgraded, 'digestVersion');
  const record = { ...event('downgrade-discovery', 'mcp-fixture', 'mcp.server_discovered'),
    time: new Date().toISOString(), data: downgraded };
  const expectedSequence = await setup.nats.store.head('mcp-fixture');
  const appended = await setup.nats.store.append({ event: record, expectedSequence });
  // Review the latest saved list, then remove the rejected sibling before dispatch.
  await reviewRestoration(setup, 'review-after-downgrade');
  const publication = await publishRestoration(setup, 'publish-after-downgrade');
  const delivery = await restorationDelivery(setup);
  await delivery.deliver(publication);
  await delivery.waitForWitness(publication);
  expect(await delivery.observe()).not.toBeNull();
  const currentHeaders = { ...headers, ...generationHeaders(publication) };
  function respond(method: string) {
    if (method === 'tools/list') return { tools: [ordinaryWrite] };
    return { content: [] };
  }
  remote.respond(respond);
  const value = await permit(setup, currentHeaders);
  const response = await send(setup, value);
  expect(response.status, await response.clone().text()).toBe(200);
  function method(call: { method: string }) { return call.method; }
  expect(remote.calls.map(method)).toEqual(['tools/list']);
  expect(await response.json()).toMatchObject({ result: { isError: true,
    content: [{ text: 'The tool list changed. An admin must review it before another call.' }] } });
  expect(appended).toMatchObject({ status: 'rejected', reason: 'invalid_event' });
  const policy = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(policy.driftHeld).toBe(true);
  expect(policy.catalogue).toEqual(inventory);
}
it('never calls a tool after a new downgrade attempt and rejected sibling removal',
  refusesDowngradeThenSiblingRemoval);
