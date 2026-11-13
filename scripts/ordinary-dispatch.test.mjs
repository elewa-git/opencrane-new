import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it, onTestFinished } from 'vitest';
import { losslessJson } from '@opencrane/events/lossless-json';
import { catalogueEvidence } from '@opencrane/models/testing';
import { ordinaryRemoteFixture, permit, send, body }
  from '@opencrane/models/testing/mcp-dispatch';
import { remoteFixture } from '@opencrane/models/testing/remote-mcp';
import { ordinaryDemo } from '../infra/dev-stack/test/ordinary-demo.mjs';
import { standardCatalogue } from '../apps/demo-mcp/src/tools.ts';

function savedTool(definition) {
  const encoded = losslessJson(JSON.stringify(definition));
  return { name: definition.name, definition: encoded.canonical, revision: encoded.digest,
    readOnly: definition.annotations.readOnlyHint,
    destructive: definition.annotations.destructiveHint, reviewed: true };
}

async function callsRecordedOrdinaryServer() {
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
