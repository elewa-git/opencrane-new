import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { approvalJourneyTool } from './journey-tool-policy.ts';

const exec = promisify(execFile);
const stubPath = new URL('./model-stub.ts', import.meta.url).pathname;

async function checksBackendBeforeRecording(): Promise<void> {
  const generation = randomUUID();
  const revision = catalogueDigest([approvalJourneyTool()]);
  const environment = { ...process.env, MODEL_STUB_PORT: '0',
    MODEL_STUB_MCP_GENERATION: generation };
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
  const environment: NodeJS.ProcessEnv = { ...process.env, MODEL_STUB_PORT: '0' };
  delete environment['MODEL_STUB_MCP_GENERATION'];
  const options = { env: environment };
  await assert.rejects(exec(process.execPath, ['--experimental-strip-types', stubPath], options),
    /Approval stub generation is missing/u);
}

test('the approval stub checks revision and generation before recording any effect',
  { timeout: 15_000 }, checksBackendBeforeRecording);
test('the approval stub refuses startup without its instance generation',
  { timeout: 15_000 }, refusesMissingGeneration);
