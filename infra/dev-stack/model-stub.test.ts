import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { approvalJourneyTool } from './journey-tool-policy.ts';
import { turnInput } from '../../apps/computer/src/turn-input.ts';

const exec = promisify(execFile);
const stubPath = new URL('./model-stub.ts', import.meta.url).pathname;

async function startsFromWakePodFixture(): Promise<void> {
  const fixture = await mkdtemp(`${process.cwd()}/infra/dev-stack/.wake-stub-`);
  const fixtureStub = `${fixture}/stub.ts`;
  const stubSource = await readFile(stubPath, 'utf8');
  await writeFile(fixtureStub, stubSource);
  const generation = randomUUID();
  const revision = catalogueDigest([approvalJourneyTool()]);
  const environment = { ...process.env, MODEL_STUB_PORT: '0',
    MODEL_STUB_MCP_GENERATION: generation, MODEL_STUB_MCP_REVISION: revision };
  const stub = spawn(process.execPath, ['--experimental-strip-types', fixtureStub],
    { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let output = '';
    for await (const chunk of stub.stdout) {
      output += chunk.toString();
      if (/Stub ready \d+/u.test(output)) break;
    }
    assert.match(output, /Stub ready \d+/u);
    const port = /Stub ready (\d+)/u.exec(output)?.[1];
    assert(port);
    const message = { type: 'message', role: 'user', content: 'Say hello.' };
    const request = { method: 'POST', body: JSON.stringify({ input: [message] }) };
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, request);
    assert.equal(response.status, 200);
    const events = await response.text();
    assert.match(events, /Hello from your computer\./u);
    assert.match(events, /event: response.completed/u);
  } finally {
    if (stub.exitCode === null) {
      const stopped = once(stub, 'exit');
      stub.kill('SIGTERM');
      await stopped;
    }
    await rm(fixture, { recursive: true, force: true });
  }
}

async function checksBackendBeforeRecording(): Promise<void> {
  const generation = randomUUID();
  const revision = catalogueDigest([approvalJourneyTool()]);
  const environment = { ...process.env, MODEL_STUB_PORT: '0',
    MODEL_STUB_MCP_GENERATION: generation, MODEL_STUB_MCP_REVISION: revision };
  const stub = spawn(process.execPath, ['--experimental-strip-types', stubPath],
    { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const [output] = await once(stub.stdout, 'data');
    assert(Buffer.isBuffer(output));
    const ready = /Stub ready (\d+)/u.exec(output.toString());
    assert(ready, 'The disposable stub must report its listening port');
    const origin = `http://127.0.0.1:${ready[1]}`;
    const body = '{"jsonrpc":"2.0","id":1,"method":"tools/call", "params":{}}';
    const requestId = randomUUID();
    const matching = { 'content-type': 'application/json', 'x-request-id': requestId,
      'x-opencrane-mcp-revision': revision, 'x-opencrane-mcp-generation': generation };
    const missing = { 'content-type': 'application/json' };
    const wrongRevision = { ...matching, 'x-opencrane-mcp-revision': '0'.repeat(64) };
    const wrongGeneration = { ...matching, 'x-opencrane-mcp-generation': randomUUID() };
    for (const headers of [missing, wrongRevision, wrongGeneration]) {
      const request = { method: 'POST', headers, body };
      const refused = await fetch(`${origin}/mcp/approval-journey/installed`, request);
      assert.equal(refused.status, 409, 'A changed or missing backend contract must refuse');
      await refused.arrayBuffer();
      const counts = await fetch(`${origin}/approval-calls`);
      assert.deepEqual(await counts.json(), [], 'A refused precondition has no recorded effect');
    }
    const request = { method: 'POST', headers: matching, body };
    const allowed = await fetch(`${origin}/mcp/approval-journey/installed`, request);
    assert.equal(allowed.status, 200);
    await allowed.arrayBuffer();
    const counts = await fetch(`${origin}/approval-calls`);
    const expected = [{ body, requestId }];
    assert.deepEqual(await counts.json(), expected, 'The matching call keeps its exact bytes');
  } finally {
    const stopped = once(stub, 'exit');
    stub.kill('SIGTERM');
    await stopped;
  }
}

async function refusesMissingGeneration(): Promise<void> {
  const revision = catalogueDigest([approvalJourneyTool()]);
  const environment: NodeJS.ProcessEnv = { ...process.env, MODEL_STUB_PORT: '0',
    MODEL_STUB_MCP_REVISION: revision };
  delete environment['MODEL_STUB_MCP_GENERATION'];
  const options = { env: environment };
  await assert.rejects(exec(process.execPath, ['--experimental-strip-types', stubPath], options),
    /Approval stub generation is missing/u);
}

async function refusesMissingRevision(): Promise<void> {
  const environment: NodeJS.ProcessEnv = { ...process.env, MODEL_STUB_PORT: '0',
    MODEL_STUB_MCP_GENERATION: randomUUID() };
  delete environment['MODEL_STUB_MCP_REVISION'];
  const options = { env: environment };
  await assert.rejects(exec(process.execPath, ['--experimental-strip-types', stubPath], options),
    /Approval stub revision is missing/u);
}

test('the approval stub checks revision and generation before recording any effect',
  { timeout: 15_000 }, checksBackendBeforeRecording);
test('the approval stub refuses startup without its instance generation',
  { timeout: 15_000 }, refusesMissingGeneration);
test('the approval stub refuses startup without its catalogue revision',
  { timeout: 15_000 }, refusesMissingRevision);
test('the wake Pod fixture starts the stub with only its packaged files',
  { timeout: 15_000 }, startsFromWakePodFixture);

async function supportsManagedVerification() {
  const folder = await mkdtemp('/tmp/managed-stub-');
  const value = randomUUID();
  const file = `${folder}/credential`;
  await writeFile(file, value, { mode: 0o600 });
  const environment = { ...process.env, MODEL_STUB_PORT: '0',
    MODEL_STUB_MCP_GENERATION: randomUUID(),
    MODEL_STUB_MCP_REVISION: catalogueDigest([approvalJourneyTool()]),
    MODEL_STUB_MANAGED_FILE: file };
  const stub = spawn(process.execPath, ['--experimental-strip-types', stubPath],
    { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  function capture(chunk: Buffer) { diagnostics += chunk.toString(); }
  stub.stderr.on('data', capture);
  stub.stdout.on('data', capture);
  try {
    await once(stub.stdout, 'data');
    const port = /Stub ready (\d+)/u.exec(diagnostics)?.[1];
    assert(port);
    const origin = `http://127.0.0.1:${port}`;
    const headers = { authorization: `Bearer ${value}`, 'content-type': 'application/json' };
    const list = await fetch(`${origin}/v1/models`, { headers });
    assert.equal(list.status, 200);
    const listed = await list.json() as { data: Array<{ id: string }> };
    assert(listed.data.length > 0);
    for (const model of listed.data) assert(model.id.length > 0);
    const request = { method: 'POST', headers, body: JSON.stringify({ stream: false }) };
    const reply = await fetch(`${origin}/v1/responses`, request);
    assert.equal(reply.headers.get('content-type'), 'application/json');
    const answer = await reply.json() as Record<string, unknown>;
    assert.equal(answer['status'], 'completed');
    assert.deepEqual(answer['usage'], { input_tokens: 10, output_tokens: 1, total_tokens: 11 });
    assert.deepEqual(answer['output'], [{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'OK' }] }]);
    const streaming = { method: 'POST', body: JSON.stringify({ stream: true }) };
    const stream = await fetch(`${origin}/v1/responses`, streaming);
    const events = await stream.text();
    assert.match(events, /event: response.completed/u);
    assert.match(events, /Hello /u);
    const counts = await fetch(`${origin}/provider-counts`);
    assert.deepEqual(await counts.json(), { managed: 2, other: 1 });
    const journey = await fetch(`${origin}/journey-counts`);
    assert.deepEqual(await journey.json(), { modelRequests: 2 });
    assert.equal(JSON.stringify(answer).includes(value), false);
    assert.equal(events.includes(value), false);
    assert.equal(diagnostics.includes(value), false);
    assert.equal(diagnostics.includes(file), false);
  } finally {
    const stopped = once(stub, 'exit');
    stub.kill('SIGTERM');
    await stopped;
    await rm(folder, { recursive: true, force: true });
  }
}
test('the stub verifies managed calls, counts credentials and keeps streaming',
  { timeout: 15_000 }, supportsManagedVerification);

async function handlesMissingCredential() {
  const folder = await mkdtemp('/tmp/missing-stub-');
  const file = `${folder}/private-credential-location`;
  const value = randomUUID();
  const environment = { ...process.env, MODEL_STUB_PORT: '0',
    MODEL_STUB_MCP_GENERATION: randomUUID(),
    MODEL_STUB_MCP_REVISION: catalogueDigest([approvalJourneyTool()]),
    MODEL_STUB_MANAGED_FILE: file };
  const stub = spawn(process.execPath, ['--experimental-strip-types', stubPath],
    { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  function capture(chunk: Buffer) { diagnostics += chunk.toString(); }
  stub.stderr.on('data', capture);
  stub.stdout.on('data', capture);
  try {
    await once(stub.stdout, 'data');
    const port = /Stub ready (\d+)/u.exec(diagnostics)?.[1];
    assert(port);
    const origin = `http://127.0.0.1:${port}`;
    let other = 0;
    for (const state of ['missing', 'empty']) {
      if (state === 'empty') await writeFile(file, '', { mode: 0o600 });
      for (const credential of [value, '']) {
        const headers = { authorization: `Bearer ${credential}` };
        const list = await fetch(`${origin}/v1/models`, { headers });
        assert.equal(list.status, 200);
        const listing = await list.text();
        const input = { method: 'POST', headers, body: JSON.stringify({ stream: false }) };
        const reply = await fetch(`${origin}/v1/responses`, input);
        assert.equal(reply.status, 200);
        const answer = await reply.text();
        other += 2;
        const counts = await fetch(`${origin}/provider-counts`);
        assert.deepEqual(await counts.json(), { managed: 0, other });
        assert.equal(listing.includes(value), false);
        assert.equal(answer.includes(value), false);
        assert.equal(listing.includes(file), false);
        assert.equal(answer.includes(file), false);
      }
    }
    assert.equal(diagnostics.includes(value), false);
    assert.equal(diagnostics.includes(file), false);
  } finally {
    const stopped = once(stub, 'exit');
    stub.kill('SIGTERM');
    await stopped;
    await rm(folder, { recursive: true, force: true });
  }
}
test('missing and empty credential files never match or disclose a bearer or file location',
  { timeout: 15_000 }, handlesMissingCredential);

async function readsPdfWhenInlineTextIsUnavailable() {
  const environment = { ...process.env, MODEL_STUB_PORT: '0',
    MODEL_STUB_MCP_GENERATION: randomUUID(),
    MODEL_STUB_MCP_REVISION: catalogueDigest([approvalJourneyTool()]) };
  const stdio: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe'];
  const options = { env: environment, stdio };
  const stub = spawn(process.execPath, ['--experimental-strip-types', stubPath], options);
  function unavailableText(): Promise<never> {
    return Promise.reject(new Error('Attachment text unavailable'));
  }
  function emptyText() {
    return Promise.resolve(Buffer.alloc(0));
  }
  try {
    const [readyOutput] = await once(stub.stdout, 'data');
    assert(Buffer.isBuffer(readyOutput));
    const port = /Stub ready (\d+)/u.exec(readyOutput.toString())?.[1];
    assert(port, 'The disposable stub must report its listening port');
    const endpoint = `http://127.0.0.1:${port}/v1/responses`;
    const files = [{ fileId: 'pdf', name: 'project.pdf', mime: 'application/pdf' }];
    for (const read of [unavailableText, emptyText]) {
      const text = await turnInput('What is the project code in the attached PDF?',
        'conversation', files, read);
      const user = { type: 'message', role: 'user', content: [{ type: 'input_text', text }] };
      const payload = { input: [user] };
      const request = { method: 'POST', body: JSON.stringify(payload) };
      const response = await fetch(endpoint, request);
      assert.equal(response.status, 200);
      const events = await response.text();
      assert.match(events, /"type":"custom_tool_call"/u,
        'Missing inline text must request a file read rather than answer with a failure');
      assert(events.includes('cat /workspace/uploads/conversation/pdf/project.pdf.md'));
      assert(!events.includes('PDF reading failed.'));
      const callId = /"call_id":"([^"]+)"/u.exec(events)?.[1];
      assert(callId, 'The file read must have a call id for its later result');

      const result = { type: 'custom_tool_call_output', call_id: callId,
        output: [{ type: 'input_text', text: 'Project code: Hazel-83.' }] };
      const followUpPayload = { input: [user, result] };
      const followUp = { method: 'POST', body: JSON.stringify(followUpPayload) };
      const answer = await fetch(endpoint, followUp);
      const completed = await answer.text();
      assert(completed.includes('The project code is Hazel-83.'));
      assert(completed.includes('event: response.completed'));
      assert(!completed.includes('"type":"custom_tool_call"'),
        'A completed read must answer rather than request the same file again');

      const failedResult = { ...result, output: [{ type: 'input_text', text: 'File unavailable' }] };
      const failedPayload = { input: [user, failedResult] };
      const failedRead = { method: 'POST', body: JSON.stringify(failedPayload) };
      const failedAnswer = await fetch(endpoint, failedRead);
      const refused = await failedAnswer.text();
      assert(refused.includes('PDF reading failed.'));
      assert(!refused.includes('"type":"custom_tool_call"'),
        'A failed file read must finish without inventing a fact or repeating the read');
    }
  } finally {
    const stopped = once(stub, 'exit');
    stub.kill('SIGTERM');
    await stopped;
  }
}
test('the PDF stand-in reads the converted file when inline text is unavailable or empty',
  { timeout: 15_000 }, readsPdfWhenInlineTextIsUnavailable);
