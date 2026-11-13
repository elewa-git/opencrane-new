import { buildTurnTools } from '../src/chat/turn-tools.ts';
import { turnToolReaders } from '../src/chat/turn-tool-readers.ts';
import { randomUUID } from 'node:crypto';
import { expect, it, onTestFinished } from 'vitest';
import { fixture } from '@opencrane/models/testing';
import { history, savePersonalKey, changeConnectionSelection, oauthConfigurationFromFile } from '@opencrane/models';
import { personalKeyFixture } from './support/personal-key.ts';

async function releaseOwnVerifiedKey() {
  const runtime = await fixture();
  onTestFinished(runtime.close.bind(runtime));
  const setup = await personalKeyFixture(runtime);
  const policy = await setup.publish();
  await setup.grant('alice');
  await setup.grant('assistant', 'assistant');
  function stage() {
    return Promise.resolve({ status: 'staged' as const, identity: {
      reference: 'fixture', uid: 'fixture', resourceVersion: '1',
    } });
  }
  function readAccessMaterial() {
    return Promise.resolve(setup.accounts[0].key);
  }
  const custody = { stage, readAccessMaterial, network: setup.remote.network };
  const input = { action: 'create', serverId: setup.serverId, connectionId: policy.connectionId,
    profileId: 'personal', changeRef: randomUUID(), expectedSequence: 0,
    expectedGeneration: 0, appendUntil: Date.now() + 60_000 };
  const saved = await savePersonalKey(setup.nats.store, setup.binding, 'alice',
    { custody, db: setup.db, network: setup.remote.network },
    { command: input, material: setup.accounts[0].key });
  const choice = await changeConnectionSelection(setup.nats.store, setup.binding, 'alice', {
    action: 'select', serverId: setup.serverId, connectionId: policy.connectionId,
    profileId: 'personal', profileRevision: saved.sequence, expectedSequence: 0,
    changeRef: randomUUID(),
  });
  const readers = turnToolReaders({ silo: 'test', store: setup.nats.store,
    binding: setup.binding });
  const offered = await buildTurnTools({ rows: [{ serverId: setup.serverId }],
    requesterId: 'alice', assistantId: 'assistant', baseMessageBytes: 0, ...readers });
  expect(offered).toHaveLength(1);
  expect(offered[0]?.serverId).toBe(setup.serverId);
  runtime.dispatchOptions.credentialDispatch = { db: setup.db, custody,
    loadConfiguration: oauthConfigurationFromFile(undefined) };
  const claims = { ...runtime.t, personalSelections: [{ serverId: setup.serverId,
    profileId: 'personal', selectionRevision: choice.sequence }] };
  const token = await runtime.sign(claims, 'decision-service');
  const member = policy.record.members[0]!;
  const headers = { ...runtime.headers, 'x-turn-token': token,
    'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call',
    'mcp-name': 'read_fixture_quote',
    'x-opencrane-gateway-generation': String(policy.record.generation),
    'x-opencrane-record-digest': policy.record.recordDigest,
    'x-opencrane-server-id': setup.serverId,
    'x-opencrane-connection-id': policy.connectionId!,
    'x-opencrane-review-revision': String(member.entry.reviewRevision) };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 'read', method: 'tools/call', params: {
    name: 'read_fixture_quote', arguments: { quoteId: 'DEMO-001' },
    _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {}, threadId: 'thread', callId: 'call-read' },
  } });
  const base = `${runtime.options.decisionUrl}`;
  const path = `/mcp/${setup.serverId}/${policy.connectionId}`;
  const permitted = await fetch(`${base}/authorize${path}`, { method: 'POST', headers, body });
  expect(permitted.status, await permitted.text()).toBe(200);
  const permit = permitted.headers.get('x-opencrane-mcp-permit');
  expect(permit).toBeTruthy();
  const sent = await fetch(`${base}/dispatch${path}`, { method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-opencrane-mcp-permit': permit! } });
  expect(sent.status).toBe(200);
  expect(await sent.json()).toMatchObject({ result: {
    isError: false, structuredContent: { actedAs: 'account-a', quoteId: 'DEMO-001' },
  } });
  const decoded: unknown = JSON.parse(Buffer.from(permit!.split('.')[0]!, 'base64url').toString());
  expect(decoded).toHaveProperty('requestId');
  const records = [];
  for await (const row of setup.nats.store.readStream('credential-*')) records.push(row);
  expect(records).toHaveLength(1);
  expect(JSON.stringify(records)).not.toContain(setup.accounts[0].key);
  const replay = await fetch(`${base}/dispatch${path}`, { method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-opencrane-mcp-permit': permit! } });
  expect(replay.status).toBe(403);
  expect((await history(setup.nats.store, `mcp-${setup.serverId}`, 'test')).length).toBeGreaterThan(4);
}
it('releases only the verified member key after a product review, save and selection',
  releaseOwnVerifiedKey, 120_000);
