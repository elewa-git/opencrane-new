import { readFile } from 'node:fs/promises';
import { toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { grantStream } from '@opencrane/authz';
import { expect, onTestFinished } from 'vitest';
import { z } from 'zod';
import { readToolPolicy, readApproval, decideApproval } from '../../src/index.ts';
import { reviewToolPolicy, publishToolPolicy } from '../../src/tool-policy.ts';
import { prepareGatewayConfiguration } from '../../src/gateway-generation.ts';
import { gatewayDelivery } from '../../src/gateway-delivery.ts';
import { catalogueEvidence, fixture, reviewCatalogue, toolEvidence } from '../fixture.ts';
import { freePort } from '../gateway-delivery-fixture.ts';
import capture from '../fixtures/codex-0.159.2-tools-call.json' with { type: 'json' };
import { oauthSelectionFixture, selectPersonalFixture } from './oauth-selection.ts';
import { remoteFixture } from './remote-mcp.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;

const review = { action: 'Write note', consequence: 'The order note changes.',
  targetArgument: 'order', fields: ['order', 'note'], stepUp: false };
export const tool = toolEvidence({ name: 'write', reviewed: true, costCents: 0, review });
export const catalogue = catalogueEvidence([tool]);
export const body = JSON.stringify(capture.body);

export async function prepare(setup: Fixture, kind: 'remote' | 'hosted' = 'remote', remote = false,
  declared = true, accountMode: 'none' | 'personal' = 'none') {
  let locator = remote ? 'https://mcp.example.test/mcp' : 'https://fixture.example.test/mcp';
  if (kind === 'hosted') locator = `registry.example.test/fixture@sha256:${'a'.repeat(64)}`;
  const registration = { serverId: 'fixture', kind, locator, registeredBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.server_registered', registration);
  const discovery = { serverId: 'fixture', connectionId: 'installed', accountMode,
    ...catalogue, ...(remote && declared ? { discoverResult: JSON.stringify({ capabilities:
      { experimental: { 'io.opencrane/expectedRevision': {} } } }) } : {}) };
  await setup.append('mcp-fixture', 'mcp.server_discovered', discovery);
  await reviewCatalogue(setup);
  const publication = { serverId: 'fixture', publishedBy: 'alice' };
  const mode = { serverId: 'fixture', connectionId: 'installed', toolName: 'write',
    toolRevision: tool.revision, mode: 'allow', setBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.tool_mode_set', mode);
  await setup.append('mcp-fixture', 'mcp.server_published', publication);
  for (const [granteeId, granteeKind] of [['alice', 'member'], ['assistant', 'assistant']]) {
    const grant = { resourceType: 'mcp_server', resourceId: 'fixture',
      granteeId, granteeKind, grantedBy: 'alice' };
    const event = await setup.append(grantStream('mcp_server', 'fixture'), 'grant.given', grant);
    await setup.auth.handler.handle(event, setup.db);
  }
  const thread = capture.body.params._meta.threadId;
  const claims = { ...setup.t, thread };
  const turn = { assistantId: 'assistant', computerId: 'computer',
    conversationId: 'conversation', turnId: 'turn', threadId: thread,
    requesterId: 'alice', task: 'chat_turn', payingGroupId: 'personal-default' };
  // Replace the fixture turn so its signed thread matches these captured bytes.
  await setup.append('computer-assistant', 'computer.turn_started', { ...turn, turnId: 'dispatch' });
  await setup.append('conversation-conversation', 'agent.turn_started',
    { conversationId: 'conversation', assistantId: 'assistant', turnId: 'dispatch' });
  const token = await setup.sign({ ...claims, turn: 'dispatch' }, 'decision-service');
  return { ...setup.headers, ...capture.headers, 'session-id': thread, 'x-turn-token': token };
}

export async function permit(setup: Fixture, headers: Record<string, string>, raw = body) {
  const request = { method: 'POST', headers, body: raw };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    request);
  expect(response.status, await response.text()).toBe(200);
  const value = response.headers.get('x-opencrane-mcp-permit');
  expect(value).toBeTruthy();
  return value!;
}

export async function send(setup: Fixture, value: string, changedBody = body,
  path = '/dispatch/mcp/fixture/installed') {
  const headers = { 'x-opencrane-mcp-permit': value, 'content-type': 'application/json' };
  const request = { method: 'POST', headers, body: changedBody };
  return fetch(`${setup.options.decisionUrl}${path}`, request);
}

export async function reviewRestoration(setup: Fixture, commandId: string, mode = 'allow',
  serverId = 'fixture') {
  const policy = await readToolPolicy(setup.nats.store, 'test', serverId);
  const catalogue = policy.catalogue!;
  function choice(declaration: NonNullable<typeof catalogue.tools>[number]) {
    return { name: declaration.name, revision: declaration.revision,
      reviewDigest: toolReviewDigest(declaration), mode };
  }
  const command = { commandId, expectedSequence: policy.sequence,
    policyRevision: policy.policyRevision, catalogueDigest: catalogue.schemaDigest,
    connectionId: policy.connectionId, accountMode: policy.accountMode,
    tools: catalogue.tools!.map(choice) };
  const result = await reviewToolPolicy(setup.nats.store, setup.binding, 'alice',
    serverId, command);
  expect(result.status).toBe('appended');
}

export async function publishRestoration(setup: Fixture, commandId: string, serverId = 'fixture') {
  const policy = await readToolPolicy(setup.nats.store, 'test', serverId);
  const command = { commandId, expectedSequence: policy.sequence,
    reviewRevision: policy.reviewRevision };
  const result = await publishToolPolicy(setup.nats.store, setup.binding, 'alice',
    serverId, command);
  expect(result.status).toBe('appended');
  return prepareGatewayConfiguration(setup.nats.store, 'test', serverId, commandId);
}

export async function restorationDelivery(setup: Fixture, preserveMemory = true) {
  let settings: typeof setup.options & { memoryRoute?: typeof setup.options.mcpRoutes[number] } =
    setup.options;
  if (preserveMemory) {
    settings = { ...settings,
      memoryRoute: { serverId: 'memory', connectionId: 'internal', upstream: 'unused' } };
  }
  const options = { db: setup.db, mode: 'live' as const, store: setup.nats.store, silo: 'test',
    child: setup.gatewayChild()!, configFile: setup.options.configFile,
    controlPort: await freePort(), settings };
  const delivery = gatewayDelivery(options);
  setup.dispatchOptions.acknowledged = delivery.acknowledged;
  async function waitForWitness(record: Awaited<ReturnType<typeof publishRestoration>>) {
    const bytes = await readFile(options.configFile, 'utf8');
    const path = /\/configuration\/\d+\/[a-f0-9-]+/u.exec(bytes)![0];
    const url = `http://127.0.0.1:${options.controlPort}${path}`;
    async function servesWitness() {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      expect(response.status).toBe(200);
      const identity: unknown = await response.json();
      expect(identity).toMatchObject({ generation: record.generation,
        recordDigest: record.recordDigest });
    }
    await expect.poll(servesWitness, { timeout: 5000 }).toBeUndefined();
  }
  return { ...delivery, waitForWitness, options };
}

export function generationHeaders(record: { generation: number; recordDigest: string;
  members: { entry: { serverId: string; connectionId: string; reviewRevision: number } }[] }) {
  const entry = record.members[0]!.entry;
  return { 'x-opencrane-gateway-generation': String(record.generation),
    'x-opencrane-record-digest': record.recordDigest, 'x-opencrane-server-id': entry.serverId,
    'x-opencrane-connection-id': entry.connectionId,
    'x-opencrane-review-revision': String(entry.reviewRevision) };
}

export async function publishedFixture(mode = 'allow', remote = false, declared = true,
  accountMode: 'none' | 'personal' = 'none') {
  const setup = await fixture();
  onTestFinished(setup.close.bind(setup));
  const headers = await prepare(setup, 'remote', remote, declared, accountMode);
  await reviewRestoration(setup, 'review-generation', mode);
  const record = await publishRestoration(setup, 'publish-generation');
  const delivery = await restorationDelivery(setup);
  await delivery.deliver(record);
  await delivery.waitForWitness(record);
  expect(await delivery.observe()).not.toBeNull();
  const constants = generationHeaders(record);
  return { setup, headers, record, delivery, constants };
}

export async function selectedPersonalFixture(mode: 'allow' | 'ask' | 'block' = 'allow',
  material = 'alice-access') {
  const context = await publishedFixture(mode, true, true, 'personal');
  const { setup } = context;
  const remote = await remoteFixture();
  onTestFinished(remote.close);
  setup.dispatchOptions.routes.length = 0;
  setup.dispatchOptions.remoteNetwork = remote.network;
  remote.revision(catalogue.schemaDigest);
  function stageMaterial() {
    const staged = { status: 'staged' as const,
      identity: { reference: 'alice-secret', uid: 'alice-uid', resourceVersion: '1' } };
    return Promise.resolve(staged);
  }
  const saved = await oauthSelectionFixture(setup.nats, 'alice', 'fixture',
    'alice-profile', stageMaterial, { locator: 'https://mcp.example.test/mcp',
      grantedScopes: ['openid', 'write'] });
  const selectionRevision = await selectPersonalFixture(setup.nats, saved);
  let materialReads = 0;
  function readAccessMaterial() {
    materialReads += 1;
    return Promise.resolve(material);
  }
  function accessMaterialReadCount() {
    return materialReads;
  }
  setup.dispatchOptions.credentialDispatch = {
    db: setup.db, custody: { readAccessMaterial },
    loadConfiguration: saved.loadConfiguration,
  };
  const claims = { ...setup.t, thread: context.headers['session-id'], turn: 'dispatch',
    personalSelections: [{ serverId: 'fixture', profileId: 'alice-profile',
      selectionRevision }] };
  const token = await setup.sign(claims, 'decision-service');
  const rawClaims: unknown = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
  expect(rawClaims).toMatchObject({ personalSelections: claims.personalSelections });
  const headers = { ...context.headers, ...context.constants, 'x-turn-token': token };
  return { setup, remote, headers, saved, accessMaterialReadCount };
}

export function requestFromPermit(value: string) {
  const encoded = value.split('.')[0]!;
  const decoded: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString());
  return z.object({ requestId: z.string() }).parse(decoded).requestId;
}

export async function grantToolApproval(setup: Fixture, headers: Record<string, string>, approve = true) {
  const mode = { serverId: 'fixture', connectionId: 'installed', toolName: 'write',
    toolRevision: tool.revision, mode: 'ask', setBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.tool_mode_set', mode);
  const publication = { serverId: 'fixture', publishedBy: 'alice' };
  await setup.append('mcp-fixture', 'mcp.server_published', publication);
  const request = { method: 'POST', headers, body };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    request);
  const answer = z.object({ approvalId: z.string() }).parse(await response.json());
  const current = await readApproval(setup.nats.store, 'test', answer.approvalId);
  if (!approve) return answer.approvalId;
  async function fresh() {}
  const result = await decideApproval(setup.nats.store, 'test', answer.approvalId,
    'alice', 'approved', true, fresh, current, setup.actor.now());
  expect(result.status).toBe('appended');
  const approved = await readApproval(setup.nats.store, 'test', answer.approvalId);
  expect(approved.state).toBe('approved');
  return answer.approvalId;
}

export async function approvalPermit(setup: Fixture, headers: Record<string, string>, approvalId: string) {
  const approvalHeaders = { ...headers, 'x-opencrane-approval-id': approvalId };
  const request = { method: 'POST', headers: approvalHeaders, body };
  return fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`, request);
}
