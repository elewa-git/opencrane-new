import { expect, it } from 'vitest';
import { requestSchema } from '../src/model-request.ts';

const call = { type: 'custom_tool_call', id: 'ct_read', call_id: 'call_read',
  name: 'exec', namespace: 'functions', input: 'text(await tools.read({}));' };
const output = { type: 'custom_tool_call_output', call_id: call.call_id,
  output: [{ type: 'input_text', text: 'The quote costs 12500 euro cents.' }] };

function continuation(item: unknown) {
  return { model: 'gpt-6.1-sol', stream: true, max_output_tokens: 2000,
    input: [item, output] };
}

function acceptsNamespace() {
  const request = continuation(call);
  expect(requestSchema.parse(request)).toEqual(request);
  const legacy = { ...call, namespace: undefined };
  expect(requestSchema.safeParse(continuation(legacy)).success).toBe(true);
}
it('keeps the namespace on a custom tool call when Codex sends its result', acceptsNamespace);

function refusesUnexpectedFields() {
  const invalidCalls = [
    { ...call, namespace: 'x'.repeat(201) },
    { ...call, namespace: { name: 'functions' } },
    { ...call, unexpected: true },
  ];
  for (const invalid of invalidCalls) {
    expect(requestSchema.safeParse(continuation(invalid)).success).toBe(false);
  }
  const invalidOutput = { ...output, namespace: 'functions' };
  const request = { ...continuation(call), input: [call, invalidOutput] };
  expect(requestSchema.safeParse(request).success).toBe(false);
}
it('still refuses oversized namespaces, wrong types and unknown fields', refusesUnexpectedFields);
