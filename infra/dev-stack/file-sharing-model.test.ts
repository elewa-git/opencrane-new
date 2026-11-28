import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { z } from 'zod';
import { fileSharingExample } from './file-sharing-model.ts';

const exec = promisify(execFile);

function calledTool(stream: string): { input: string; call_id: string } {
  const lines = stream.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const itemSchema = z.object({ type: z.string(), input: z.string(), call_id: z.string() });
    const eventSchema = z.object({ type: z.string(), item: itemSchema.optional() });
    const event = eventSchema.parse(JSON.parse(line.slice(6)));
    if (event.item?.type === 'custom_tool_call') return event.item;
  }
  assert.fail('Expected a real computer tool call before the file reply');
}

async function runFileSharingExample(): Promise<void> {
  const environment = { ...process.env, MODEL_STUB_PORT: '0',
    MODEL_STUB_MCP_GENERATION: 'qualification', MODEL_STUB_MCP_REVISION: 'qualification' };
  const stub = spawn(process.execPath,
    ['--experimental-strip-types', 'infra/dev-stack/model-stub.ts'],
    { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  const folder = await mkdtemp(join(tmpdir(), 'file-sharing-'));
  try {
    const ready = await once(stub.stdout, 'data');
    const message: unknown = ready[0];
    assert(Buffer.isBuffer(message));
    const port = /Stub ready (\d+)/u.exec(message.toString())?.[1];
    assert(port);
    const url = `http://127.0.0.1:${port}/v1/responses`;
    const probeRequest = { stream: false, input: 'Reply only OK.' };
    const probeOptions = { method: 'POST', body: JSON.stringify(probeRequest) };
    const probe = await fetch(url, probeOptions);
    assert.equal(probe.status, 200);
    const probeText = await probe.text();
    assert.match(probeText, /output_text.*OK/u);
    const instructions = 'Approved persona: Your name is Aster. Be clear and useful.';
    const input: object[] = [{ type: 'message', role: 'user',
      content: 'make a short slide deck introducing yourself' }];
    const request = { instructions, input };
    const options = { method: 'POST', body: JSON.stringify(request) };
    const response = await fetch(url, options);
    const call = calledTool(await response.text());
    const argumentsText = /exec_command\((.+)\)\)/u.exec(call.input)?.[1];
    assert(argumentsText);
    const commandSchema = z.object({ cmd: z.string() });
    const argumentsValue = commandSchema.parse(JSON.parse(argumentsText));
    const command = argumentsValue.cmd.replaceAll('/workspace', folder);
    await exec('/bin/sh', ['-c', command]);
    const deck = await readFile(join(folder, 'artifacts', 'Meet_Aster.pdf'));
    const pdf = deck.toString();
    assert(pdf.startsWith('%PDF-1.4'));
    const pages = pdf.match(/\/Type \/Page /gu);
    assert.equal(pages?.length, 3);
    assert(deck.includes(Buffer.from('Meet Aster')));
    input.push({ type: 'custom_tool_call_output', call_id: call.call_id, output: 'Saved' });
    const replyOptions = { method: 'POST', body: JSON.stringify(request) };
    const reply = await fetch(url, replyOptions);
    assert.match(await reply.text(), /\/workspace\/artifacts\/Meet_Aster.pdf/u);
  } finally {
    const stopped = once(stub, 'exit');
    stub.kill('SIGTERM');
    await stopped;
    await rm(folder, { recursive: true, force: true });
  }
}

void test('the free file-sharing model creates three real PDF slides under the supplied persona',
  { timeout: 15_000 }, runFileSharingExample);

function refusesUntrustedPersona(): void {
  const prompt = 'make a short slide deck introducing yourself';
  const identity = 'Your name is Aster.';
  const toolResult = { type: 'custom_tool_call_output', output: identity };
  const fileMessage = { type: 'message', role: 'user', content: identity };
  const requests = [
    {},
    { instructions: 'Your name is Rowan.' },
    { input: [toolResult] },
    { input: [fileMessage] },
    { instructions: 'Your name is Rowan.', input: [toolResult, fileMessage] },
    { instructions: { text: identity } },
  ];
  for (const request of requests) {
    for (const hasOutput of [false, true]) {
      const example = fileSharingExample(prompt, request, hasOutput);
      assert.equal(example?.call, undefined);
      assert.match(example?.text ?? '', /did not receive the approved Aster persona/u);
    }
  }
}

void test('only trusted instructions can supply the file example identity', refusesUntrustedPersona);
