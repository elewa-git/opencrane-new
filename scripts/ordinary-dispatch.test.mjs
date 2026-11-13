import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it, onTestFinished } from 'vitest';
import { losslessJson } from '@opencrane/events/lossless-json';
import { catalogueEvidence } from '@opencrane/models/testing';
import { ingestUsage } from '@opencrane/models';
import { ordinaryRemoteFixture, permit, send, body }
  from '@opencrane/models/testing/mcp-dispatch';
import { remoteFixture } from '@opencrane/models/testing/remote-mcp';
import { ordinaryDemo } from '../infra/dev-stack/test/ordinary-demo.mjs';
import { checkOrdinaryCosts } from '../infra/dev-stack/test/ordinary-evidence.mjs';
import { standardCatalogue } from '../apps/demo-mcp/src/tools.ts';

function savedTool(definition) {
  const encoded = losslessJson(JSON.stringify(definition));
  return { name: definition.name, definition: encoded.canonical, revision: encoded.digest,
    readOnly: definition.annotations.readOnlyHint,
    destructive: definition.annotations.destructiveHint, reviewed: true };
}

async function recordedOrdinaryFixture() {
  const directory = await mkdtemp(`${tmpdir()}/ordinary-dispatch-`);
  async function removeDirectory() { await rm(directory, { recursive: true, force: true }); }
  onTestFinished(removeDirectory);
  const demo = ordinaryDemo(directory);
  async function closeDemo() { await demo.close(); }
  onTestFinished(closeDemo);
  const statuses = [];
  const errors = [];
  async function responseStatus(_request, reply) { statuses.push(reply.statusCode); }
  async function responseError(_request, _reply, error) { errors.push(error.code); }
  demo.addHook('onResponse', responseStatus);
  demo.addHook('onError', responseError);
  await demo.ready();
  function forward(request, response) {
    // Match the guarded journey transport's fixed Unix-socket path.
    request.url = '/';
    demo.routing(request, response);
  }
  const transport = await remoteFixture(false, forward);
  onTestFinished(transport.close);
  const tools = standardCatalogue().tools.map(savedTool);
  const inventory = { ...catalogueEvidence(tools), serverId: 'fixture',
    connectionId: 'installed', accountMode: 'none',
    discoverResult: JSON.stringify({ capabilities: { tools: {} } }) };
  const { setup, headers } = await ordinaryRemoteFixture('allow', undefined, inventory);
  setup.dispatchOptions.remoteNetwork = transport.network;
  return { directory, setup, headers, statuses, errors };
}

async function callsRecordedOrdinaryServer() {
  const { directory, setup, headers, statuses, errors } = await recordedOrdinaryFixture();
  const call = JSON.parse(body);
  call.params.name = 'read_fixture_quote';
  call.params.arguments = { quoteId: 'DEMO-001' };
  const raw = JSON.stringify(call);
  const readHeaders = { ...headers, 'mcp-name': 'read_fixture_quote' };
  const value = await permit(setup, readHeaders, raw);
  const reply = await send(setup, value, raw);
  const replyText = await reply.text();
  expect(reply.status, JSON.stringify({ statuses, errors })).toBe(200);
  expect(JSON.parse(replyText)).toMatchObject({ result: { isError: false,
    structuredContent: { quoteId: 'DEMO-001', amountCents: 12500,
      slot: 'morning', effectCount: 0 } } });
  const recorded = await readFile(`${directory}/ordinary-wire.jsonl`, 'utf8');
  expect(JSON.parse(recorded)).toEqual({ method: 'tools/call', name: 'read_fixture_quote',
    stripped: true, protocolVersion: '2026-07-28', session: false, revision: false });
  await writeFile(`${directory}/ordinary-drift`, 'changed', { mode: 0o600 });
  const nextPermit = await permit(setup, readHeaders, raw);
  const refused = await send(setup, nextPermit, raw);
  expect(await refused.json()).toMatchObject({ result: { isError: true, content: [{
    text: 'The tool list changed. An admin must review it before another call.' }] } });
  expect(await readFile(`${directory}/ordinary-wire.jsonl`, 'utf8')).toBe(recorded);
}
it('calls a reviewed ordinary server in a member turn through the recording transport',
  callsRecordedOrdinaryServer);

function gatewayBody(name, callId) {
  const call = JSON.parse(body);
  call.id = callId;
  call.params.name = name;
  call.params._meta.callId = callId;
  call.params.arguments = { quoteId: 'DEMO-001' };
  if (name === 'change_delivery_slot') call.params.arguments.slot = 'afternoon';
  return JSON.stringify(call);
}

async function checksGatewayRefusalEvidence() {
  const { directory, setup, headers } = await recordedOrdinaryFixture();
  async function call(name, callId) {
    const raw = gatewayBody(name, callId);
    const options = { method: 'POST', headers: { ...headers, 'mcp-name': name }, body: raw };
    const url = `http://127.0.0.1:${setup.options.port}/mcp/fixture/installed`;
    const reply = await fetch(url, options);
    expect(reply.status).toBe(200);
    return reply.json();
  }
  expect(await call('read_fixture_quote', 'call_read')).toMatchObject({ result: {
    structuredContent: { amountCents: 12500, slot: 'morning', effectCount: 0 } } });
  expect(await call('change_delivery_slot', 'call_write')).toMatchObject({ result: {
    structuredContent: { amountCents: 12500, slot: 'afternoon', effectCount: 1 } } });
  const before = await readFile(`${directory}/ordinary-wire.jsonl`, 'utf8');
  await writeFile(`${directory}/ordinary-drift`, 'changed', { mode: 0o600 });
  expect(await call('read_fixture_quote', 'call_drift')).toMatchObject({ result: {
    isError: true, content: [{
      text: 'The tool list changed. An admin must review it before another call.' }] } });
  expect(await readFile(`${directory}/ordinary-wire.jsonl`, 'utf8')).toBe(before);
  async function dispatchRecords() {
    await ingestUsage(setup.actor, setup.options.usageFile);
    const records = [];
    for await (const row of setup.nats.store.readStream('decision-*')) {
      const event = row.event;
      if (event.type !== 'tool.dispatch_recorded' || event.data.serverId !== 'fixture') continue;
      const { toolName, outcome, evidence, costStatus, costCents, adapter } = event.data;
      const record = { toolName, outcome, evidence, costStatus, costCents,
        remote: adapter !== undefined };
      records.push(record);
    }
    return records;
  }
  await expect.poll(dispatchRecords).toHaveLength(3);
  const records = await dispatchRecords();
  checkOrdinaryCosts(records);
  const changedCost = structuredClone(records);
  changedCost[0].costCents = 7;
  function refusesInventedAmount() { checkOrdinaryCosts(changedCost); }
  expect(refusesInventedAmount).toThrow();
}
it('checks two remote replies and the separate gateway receipt for a drift refusal',
  checksGatewayRefusalEvidence);
