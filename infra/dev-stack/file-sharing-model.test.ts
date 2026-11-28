import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);

function calledTool(stream: string): { input: string; call_id: string } {
  const lines = stream.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const event = JSON.parse(line.slice(6)) as {
      type: string; item?: { type: string; input: string; call_id: string };
    };
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
    const [ready] = await once(stub.stdout, 'data');
    const port = /Stub ready (\d+)/u.exec(String(ready))?.[1];
    assert(port);
    const url = `http://127.0.0.1:${port}/v1/responses`;
    const instructions = 'Approved persona: Your name is Aster. Be clear and useful.';
    const input: object[] = [{ type: 'message', role: 'user',
      content: 'make a short slide deck introducing yourself' }];
    const request = { instructions, input };
    const options = { method: 'POST', body: JSON.stringify(request) };
    const response = await fetch(url, options);
    const call = calledTool(await response.text());
    const argumentsText = /exec_command\((.+)\)\)/u.exec(call.input)?.[1];
    assert(argumentsText);
    const argumentsValue = JSON.parse(argumentsText) as { cmd: string };
    const command = argumentsValue.cmd.replaceAll('/workspace', folder);
    await exec('/bin/sh', ['-c', command]);
    const deck = await readFile(join(folder, 'artifacts', 'Meet_Aster.pdf'));
    assert(deck.toString().startsWith('%PDF-1.4'));
    assert.equal(deck.toString().match(/\/Type \/Page /gu)?.length, 3);
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

test('the free file-sharing model creates three real PDF slides under the supplied persona',
  { timeout: 15_000 }, runFileSharingExample);
