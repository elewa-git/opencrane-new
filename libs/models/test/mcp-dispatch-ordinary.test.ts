import { ordinaryRemoteFixture, remoteMethod, review } from './support/mcp-dispatch.ts';
import { body, catalogue, tool, prepare, permit, send, reviewRestoration, publishRestoration,
  restorationDelivery, generationHeaders, publishedFixture }
  from './support/mcp-dispatch-fixture.ts';
import { remoteFixture } from './support/remote-mcp.ts';
import { losslessJson } from '@opencrane/events/lossless-json';
import { approvalDecision } from '../src/approvals.ts';
import { mcpPolicy, parseMcpCall } from '../src/mcp.ts';
import type { StoredEvent } from '@opencrane/event-store';
import { z } from 'zod';
import { expect, it, onTestFinished } from 'vitest';
import { approvalCards, decideApproval, readApproval, readToolPolicy } from '../src/index.ts';
import { catalogueEvidence, fixture } from './fixture.ts';
import capture from './fixtures/codex-0.159.2-tools-call.json' with { type: 'json' };
import { approvalForReviewedTool } from './support/mcp-dispatch-assertions.ts';

async function runsOrdinaryRemoteTool() {
  const { setup, headers, remote } = await ordinaryRemoteFixture();
  const value = await permit(setup, headers);
  const response = await send(setup, value);
  expect(response.status, await response.text()).toBe(200);
  expect(remote.calls.map(remoteMethod)).toEqual(['tools/list', 'tools/call']);
  const sentCall: unknown = JSON.parse(remote.received[1]!.raw.toString());
  expect(sentCall).toHaveProperty('params._meta', {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {} });
  expect(remote.received[1]!.headers).not.toHaveProperty('x-opencrane-mcp-revision');
  expect(JSON.stringify(sentCall)).not.toMatch(/threadId|sessionId|sandbox|clientInfo/u);
  const decisions: StoredEvent[] = [];
  const last = await setup.nats.store.head();
  for (let position = 1; position <= last; position++) {
    decisions.push(await setup.nats.store.readEvent(position));
  }
  const dispatch = decisions.find(row => row.event.type === 'tool.dispatch_recorded');
  expect(dispatch?.event.data).toMatchObject({ costStatus: 'not_reported' });
}

it('runs an ordinary reviewed remote tool and records that no cost was reported', runsOrdinaryRemoteTool);

async function refusesOrdinaryCatalogueDrift() {
  const { setup, headers, remote } = await ordinaryRemoteFixture();
  function changed() { return { tools: [] }; }
  remote.respond(changed);
  const value = await permit(setup, headers);
  const response = await send(setup, value);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ result: { isError: true,
    content: [{ text: 'The tool list changed. An admin must review it before another call.' }] } });
  const policy = await readToolPolicy(setup.nats.store, 'test', 'fixture');
  expect(policy.driftHeld).toBe(true);
  expect(remote.calls.map(remoteMethod)).toEqual(['tools/list']);
}

it('blocks an ordinary remote tool when its current list differs from the review', refusesOrdinaryCatalogueDrift);

async function preservesNumbersWithoutAgentDetails() {
  const context = await publishedFixture('allow', true);
  const { setup } = context;
  const remote = await remoteFixture();
  onTestFinished(remote.close);
  setup.dispatchOptions.routes.length = 0;
  setup.dispatchOptions.remoteNetwork = remote.network;
  setup.dispatchOptions.requireCatalogue = function requireCatalogue() {};
  remote.revision(catalogue.schemaDigest);
  const raw = body.replace('"arguments":{', '"arguments":{"number":1.0e3,');
  const value = await permit(setup, { ...context.headers, ...context.constants }, raw);
  const response = await send(setup, value, raw);
  expect(response.status, await response.text()).toBe(200);
  const sent = remote.received[0]!.raw.toString();
  expect(sent).toContain('"number":1.0e3');
  const sentCall: unknown = JSON.parse(sent);
  expect(sentCall).toHaveProperty('params._meta', {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {} });
  expect(sent).not.toMatch(/threadId|thread_id|sessionId|session_id|probe-model|sandbox|0\.159\.2|clientInfo/u);
}

it('removes agent details on the wire while preserving exact argument numbers', preservesNumbersWithoutAgentDetails);

async function approvesOrdinaryDescription(_name: string, description: string | undefined,
  consequence: string) {
  const { setup, headers, remote } = await ordinaryRemoteFixture('ask', description);
  const approvalId = await approvalForReviewedTool(setup, headers, false);
  expect(remote.calls).toHaveLength(0);
  const waiting = await readApproval(setup.nats.store, 'test', approvalId);
  expect(waiting.state).toBe('requested');
  const cards = await approvalCards(setup.nats.store, 'test', 'conversation', 'alice', setup.keys);
  expect(cards).toHaveLength(1);
  expect(cards[0]!.review).toMatchObject({ tool: 'write', target: 'write', consequence,
    data: losslessJson(JSON.stringify(capture.body.params.arguments)).canonical });
  async function fresh() {}
  const approved = await decideApproval(setup.nats.store, 'test', approvalId,
    'alice', 'approved', true, fresh, waiting);
  expect(approved.status).toBe('appended');
  const value = await permit(setup, { ...headers, 'x-opencrane-approval-id': approvalId });
  const response = await send(setup, value);
  expect(response.status, await response.text()).toBe(200);
  expect(remote.calls.map(remoteMethod)).toEqual(['tools/list', 'tools/call']);
}

const ordinaryDescriptions = [
  ['missing', undefined, 'Run the reviewed tool.'],
  ['empty', '', 'Run the reviewed tool.'],
  ['long', 'x'.repeat(8001), 'x'.repeat(8000)],
] as const;

it.each(ordinaryDescriptions)(
  'shows an ordinary approval card and runs the approved call for a %s description',
  approvesOrdinaryDescription);

async function recordsReportedOrdinaryCost(cost: number) {
  const { setup, headers, remote, ordinaryTool } = await ordinaryRemoteFixture();
  function result(method: string) {
    if (method === 'tools/list') return { tools: [JSON.parse(ordinaryTool.definition) as unknown] };
    return { content: [], _meta: { 'io.opencrane/costCents': cost } };
  }
  remote.respond(result);
  const value = await permit(setup, headers);
  const response = await send(setup, value);
  expect(response.status, await response.text()).toBe(200);
  const last = await setup.nats.store.head();
  const dispatch = await setup.nats.store.readEvent(last);
  expect(dispatch.event.type).toBe('tool.dispatch_recorded');
  if (cost < 0 || cost === 0.5 || cost === 9007199254740992) {
    expect(dispatch.event.data).toMatchObject({ costStatus: 'invalid' });
    expect(dispatch.event.data).not.toHaveProperty('costCents');
  } else {
    expect(dispatch.event.data).toMatchObject({ costStatus: 'reported', costCents: cost });
  }
}

it.each([0, 7, -1, 0.5, 9007199254740992])('records an ordinary tool reported cost after execution: %s', recordsReportedOrdinaryCost);

async function checksEveryOrdinaryCataloguePage() {
  const { setup, headers, remote, ordinaryTool } = await ordinaryRemoteFixture();
  function result(method: string, cursor?: string) {
    if (method === 'tools/list' && cursor === undefined) {
      return { tools: [], nextCursor: 'remaining-tools' };
    }
    if (method === 'tools/list') {
      return { tools: [JSON.parse(ordinaryTool.definition) as unknown] };
    }
    return { content: [], isError: false };
  }
  remote.respond(result);
  const value = await permit(setup, headers);
  const response = await send(setup, value);
  expect(response.status, await response.text()).toBe(200);
  expect(remote.calls.map(remoteMethod)).toEqual(['tools/list', 'tools/list', 'tools/call']);
}

it('compares every page of an ordinary server list before executing', checksEveryOrdinaryCataloguePage);

async function refusesUnreviewedDeclaredArguments(kind: 'target' | 'object' | 'array') {
  const setup = await fixture();
  onTestFinished(setup.close.bind(setup));
  const headers = await prepare(setup);
  const descriptor = { ...review };
  if (kind === 'target') descriptor.targetArgument = 'unlisted';
  const declaration = { ...tool, review: descriptor };
  const discovery = { serverId: 'fixture', connectionId: 'installed', accountMode: 'none',
    ...catalogueEvidence([declaration]) };
  await setup.append('mcp-fixture', 'mcp.server_discovered', discovery);
  await reviewRestoration(setup, 'argument-review', 'ask');
  const record = await publishRestoration(setup, 'argument-publication');
  const delivery = await restorationDelivery(setup);
  await delivery.deliver(record);
  await delivery.waitForWitness(record);
  expect(await delivery.observe()).not.toBeNull();
  Object.assign(headers, generationHeaders(record));
  const argumentsValue: Record<string, unknown> = { ...capture.body.params.arguments };
  if (kind === 'object') argumentsValue['note'] = { text: 'ordinary text' };
  if (kind === 'array') argumentsValue['note'] = ['ordinary text'];
  const call = { ...capture.body, params: { ...capture.body.params, arguments: argumentsValue } };
  const parsed = parseMcpCall(JSON.stringify(call));
  const policy = await mcpPolicy(setup.nats.store, 'test', 'fixture', 'installed', parsed,
    headers, Infinity, setup.dispatchOptions.acknowledged);
  expect(policy.outcome).toBe('ask');
  const bound = { requesterId: 'alice', assistantId: 'assistant', conversationId: 'conversation',
    turnId: 'dispatch', serverId: 'fixture', connectionId: 'installed' };
  async function fresh() {}
  const before = await setup.nats.store.head();
  const decision = approvalDecision(setup.nats.store, 'test', bound, policy, setup.keys,
    setup.actor.now, fresh, 'unreviewed-arguments');
  await expect(decision).rejects.toThrow('Unreviewed arguments');
  expect(await setup.nats.store.head()).toBe(before);
  const cards = await approvalCards(setup.nats.store, 'test', 'conversation', 'alice', setup.keys);
  expect(cards).toEqual([]);
  expect(setup.received()).toBe(0);
}

it.each(['target', 'object', 'array'] as const)(
  'refuses unreviewed declared approval arguments: %s', refusesUnreviewedDeclaredArguments);

async function approvesStructuredOrdinaryArguments(kind: 'object' | 'array') {
  const { setup, headers, remote } = await ordinaryRemoteFixture('ask');
  const note = kind === 'object' ? { text: 'ordinary text' } : ['ordinary text'];
  const argumentsValue = { ...capture.body.params.arguments, note };
  const call = { ...capture.body, params: { ...capture.body.params, arguments: argumentsValue } };
  const raw = JSON.stringify(call);
  const request = { method: 'POST', headers, body: raw };
  const response = await fetch(`${setup.options.decisionUrl}/authorize/mcp/fixture/installed`,
    request);
  expect(response.status).toBe(403);
  const answer = z.object({ approvalId: z.string() }).parse(await response.json());
  const cards = await approvalCards(setup.nats.store, 'test', 'conversation', 'alice', setup.keys);
  expect(cards).toHaveLength(1);
  expect(cards[0]!.review.data).toBe(losslessJson(JSON.stringify(argumentsValue)).canonical);
  const waiting = await readApproval(setup.nats.store, 'test', answer.approvalId);
  async function fresh() {}
  const approved = await decideApproval(setup.nats.store, 'test', answer.approvalId,
    'alice', 'approved', true, fresh, waiting);
  expect(approved.status).toBe('appended');
  const approvedHeaders = { ...headers, 'x-opencrane-approval-id': answer.approvalId };
  const value = await permit(setup, approvedHeaders, raw);
  const sent = await send(setup, value, raw);
  expect(sent.status, await sent.text()).toBe(200);
  expect(remote.calls).toHaveLength(2);
  const sentCall: unknown = JSON.parse(remote.received[1]!.raw.toString());
  expect(sentCall).toMatchObject({ params: { arguments: argumentsValue } });
}

it.each(['object', 'array'] as const)(
  'shows and approves exact ordinary structured arguments: %s', approvesStructuredOrdinaryArguments);
