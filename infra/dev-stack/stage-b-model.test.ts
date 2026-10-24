import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { stageBModelAnswer, stageBModelCall } from './stage-b-model.ts';

const user = { type: 'message', role: 'user', content: 'STAGE_B_READ Read the quote.' };
const exec = { type: 'custom', name: 'exec' };
const namespace = { type: 'namespace', name: 'functions', tools: [exec] };
const deferred = { type: 'additional_tools', tools: [namespace] };
const quote = { quoteId: 'DEMO-001', amountCents: 12500, slot: 'morning', effectCount: 0 };

async function callsDeferredRead() {
  const call = stageBModelCall({ input: [deferred, user] });
  assert.equal(call?.type, 'custom_tool_call');
  assert(call && 'input' in call);
  const name = 'mcp__oc_fixture__read_fixture_quote';
  const calls: unknown[] = [];
  const output: unknown[] = [];
  async function read(args: unknown) {
    calls.push(args);
    return { structuredContent: quote };
  }
  function text(value: unknown) { output.push(value); }
  const context = { ALL_TOOLS: [{ name }], tools: { [name]: read }, text };
  await runInNewContext(`(async function run() { ${call.input} })()`, context);
  assert.equal(JSON.stringify(calls), '[{"quoteId":"DEMO-001"}]');
  assert.equal(JSON.stringify(output[0]), JSON.stringify({ offeredTool: name }));
  const result = { type: 'custom_tool_call_output', call_id: call.call_id,
    output: [{ type: 'text', text: JSON.stringify(output[1]) }] };
  const followUp = { input: [deferred, user, result] };
  assert.equal(stageBModelCall(followUp), undefined);
  assert.equal(stageBModelAnswer(followUp),
    'Quote DEMO-001: 12500 euro cents, morning delivery. Recorded effects: 0.');
}
test('the first response calls the published deferred read once and answers its result',
  callsDeferredRead);

async function refusesUnavailableTools() {
  const call = stageBModelCall({ input: [deferred, user] });
  assert(call && 'input' in call);
  const name = 'mcp__oc_fixture__read_fixture_quote';
  for (const available of [[], [{ name }, { name }]]) {
    const context = { ALL_TOOLS: available, tools: {}, text() {} };
    const executing = runInNewContext(`(async function run() { ${call.input} })()`, context);
    await assert.rejects(executing, /Expected one published demo tool/u);
  }
}
test('missing and ambiguous deferred tools refuse without a guessed call', refusesUnavailableTools);

function keepsDirectCalls() {
  const direct = { type: 'namespace', name: 'mcp__oc_fixture',
    tools: [{ type: 'function', name: 'read_fixture_quote' }] };
  for (const body of [{ input: [user], tools: [direct] },
    { input: [{ type: 'additional_tools', tools: [direct] }, user] }]) {
    const call = stageBModelCall(body);
    assert.equal(call?.type, 'function_call');
    assert.equal(call?.namespace, direct.name);
    const output = { type: 'function_call_output', call_id: call?.call_id,
      output: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(quote) }] }) };
    const followUp = { ...body, input: [...body.input, output] };
    assert.equal(stageBModelCall(followUp), undefined);
    assert.match(stageBModelAnswer(followUp) ?? '', /12500 euro cents, morning delivery/u);
  }
}
test('direct namespaces in either request location still complete the read', keepsDirectCalls);

function bindsOutputToThisCall() {
  const unrelated = { type: 'function_call_output', call_id: 'other', output: quote };
  const previous = { type: 'custom_tool_call_output', call_id: 'call_read_fixture_quote',
    output: quote };
  const input: unknown[] = [deferred, previous, user, unrelated];
  assert(stageBModelCall({ input }));
  assert.equal(stageBModelAnswer({ input }), undefined);
  const failed = { ...previous, output: 'Tool failed' };
  input.push(failed);
  assert.equal(stageBModelCall({ input }), undefined);
  assert.equal(stageBModelAnswer({ input }), 'The demo tool did not return a quote.');
}
test('only this turn and call result can answer, and a failed tool is not repeated',
  bindsOutputToThisCall);

function ordinaryAndWrite() {
  assert.equal(stageBModelCall({ input: [] }), undefined);
  assert.equal(stageBModelAnswer({ input: [] }), undefined);
  function missing() { stageBModelCall({ input: [user] }); }
  assert.throws(missing, /not offered/u);
  const write = { ...user, content: 'STAGE_B_WRITE Change the slot.' };
  const call = stageBModelCall({ input: [deferred, write] });
  assert(call && 'input' in call);
  assert.match(call.input, /__change_delivery_slot/u);
  assert.match(call.input, /"slot":"afternoon"/u);
}
test('ordinary prompts stay unchanged and the write uses the same deferred interface',
  ordinaryAndWrite);
