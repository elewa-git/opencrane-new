import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDemoServer } from '../../apps/demo-mcp/src/server.ts';
import { catalogue } from '../../apps/demo-mcp/src/tools.ts';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { eventEnvelopeSchema, toolApprovalRequestedDataSchema } from '@opencrane/events';
import { losslessJson } from '@opencrane/events/lossless-json';

async function retainsFirstReadbackAfterTermination() {
  const output = await mkdtemp(join(tmpdir(), 'stage-b-collector-'));
  const server = createDemoServer();
  const socket = join(output, 'demo.sock');
  await server.listen({ path: socket });
  function toolRevision(tool: typeof catalogue.tools[number]) {
    const parsed = losslessJson(JSON.stringify(tool));
    return { name: tool.name, revision: parsed.digest };
  }
  const tools = catalogue.tools.map(toolRevision);
  const revision = catalogueDigest(tools);
  const script = new URL('./stage-b-collector-child.ts', import.meta.url);
  const options = { execArgv: ['--experimental-strip-types'], silent: true };
  const child = fork(script, [output, socket, revision], options);
  let stderr = '';
  function diagnostic(chunk: Buffer) {
    stderr += chunk.toString();
  }
  child.stderr!.on('data', diagnostic);
  try {
    const waitOptions = { signal: AbortSignal.timeout(10000) };
    const message = await once(child, 'message', waitOptions);
    assert.equal(message[0], 'first readback received', stderr);
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    const saved = JSON.parse(await readFile(`${output}/live-probe.json`, 'utf8')) as {
      before: { at: string; value: unknown };
      beforeResponse: { at: string; status: number; body: string };
    };
    assert.deepEqual(saved.before.value, { quoteId: 'DEMO-001', amountCents: 12500,
      slot: 'morning', effectCount: 0 });
    assert.equal(saved.beforeResponse.at, saved.before.at);
    assert.equal(saved.beforeResponse.status, 200);
    const original: unknown = JSON.parse(saved.beforeResponse.body);
    assert.deepEqual(original, { jsonrpc: '2.0', id: 'readback-before', result: {
      structuredContent: { quoteId: 'DEMO-001', slot: 'morning', amountCents: 12500,
        effectCount: 0 },
      content: [{ type: 'text', text: '{"quoteId":"DEMO-001","amountCents":12500,' +
        '"slot":"morning","effectCount":0}' }], isError: false,
    } });
    const journal = await readFile(`${output}/live-probe.jsonl`, 'utf8');
    assert.match(journal, /"name":"beforeResponse"/u);
    assert.match(journal, /"name":"before"/u);
  } finally {
    child.kill('SIGKILL');
    await server.close();
    await rm(output, { recursive: true, force: true });
  }
}
test('saves the first demo-server readback even when the collector is terminated',
  { timeout: 15000 }, retainsFirstReadbackAfterTermination);

async function retainsOriginalRecordsWhenNextReadFails() {
  const output = await mkdtemp(join(tmpdir(), 'stage-b-records-'));
  const { createStageBCollector, collectStageBRecords } = await import('./stage-b-collector.ts');
  const { approvalEvidence } = await import('./test/stage-b-evidence.ts');
  const evidence = approvalEvidence();
  const original = evidence.records.request;
  const schema = eventEnvelopeSchema(toolApprovalRequestedDataSchema);
  const request = { sequence: original.sequence, event: schema.parse(original.event) };
  const unavailable = new Error('event stream interrupted');
  async function* readStream() {
    yield request;
    throw unavailable;
  }
  function accept() {
    return true;
  }
  const store = { readStream };
  const collector = createStageBCollector(output);
  async function collect() {
    await collectStageBRecords(collector, 'approvalRecords', store, request.event.subject,
      'dev', accept);
  }
  try {
    await assert.rejects(collect, unavailable);
    const saved: unknown = JSON.parse(await readFile(`${output}/live-probe.json`, 'utf8'));
    assert.deepEqual(saved, { approvalRecords: [request] });
    const journal = await readFile(`${output}/live-probe.jsonl`, 'utf8');
    const entry: unknown = JSON.parse(journal.trim());
    assert.deepEqual(entry, { name: 'approvalRecords', value: [request] });
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}
test('keeps each original event when the following event read fails',
  retainsOriginalRecordsWhenNextReadFails);

async function retainsEvidenceWhenBrowserCloses() {
  const { createServer } = await import('node:http');
  const { chromium } = await import('playwright');
  const { createStageBCollector, collectStageBApprovalResponse } =
    await import('./stage-b-collector.ts');
  const output = await mkdtemp(join(tmpdir(), 'stage-b-browser-close-'));
  function handle(request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse) {
    request.resume();
    if (request.url === '/') {
      response.end('<title>Collector response fixture</title>');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.write('{"status":');
    // Leave the body unfinished to reproduce the browser read that blocked the final save.
  }
  const server = createServer(handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const collector = createStageBCollector(output);
  try {
    collector.record('before', { value: { slot: 'morning', effectCount: 0 } });
    await page.goto(`http://127.0.0.1:${address.port}`);
    function approvalResponse(response: import('playwright').Response) {
      const url = response.url();
      return url.includes('/approvals');
    }
    const observed = page.waitForResponse(approvalResponse);
    await page.evaluate(`void fetch('/api/conversations/test/approvals', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: '{"decision":"approve"}'
    })`);
    const response = await observed;
    const reading = collectStageBApprovalResponse(collector, response);
    await browser.close();
    const saved = JSON.parse(await readFile(`${output}/live-probe.json`, 'utf8')) as {
      before: unknown; approvalResponses: Array<{ command: unknown; status: number }>;
    };
    assert.deepEqual(saved.before, { value: { slot: 'morning', effectCount: 0 } });
    assert.equal(saved.approvalResponses[0]!.status, 200);
    assert.deepEqual(saved.approvalResponses[0]!.command, { decision: 'approve' });
    await reading;
  } finally {
    await browser.close();
    server.closeAllConnections();
    const closed = once(server, 'close');
    server.close();
    await closed;
    await rm(output, { recursive: true, force: true });
  }
}
test('keeps evidence when the browser closes during an unfinished approval response',
  { timeout: 30000 }, retainsEvidenceWhenBrowserCloses);

async function keepsEarlierObservationsAndRedactsEmail() {
  const { createStageBCollector } = await import('./stage-b-collector.ts');
  const { stat } = await import('node:fs/promises');
  const output = await mkdtemp(join(tmpdir(), 'stage-b-journal-'));
  try {
    const collector = createStageBCollector(output);
    collector.record('policy', { revision: 1, contact: 'fixture@example.test' });
    collector.record('policy', { revision: 2, contact: 'fixture@example.test' });
    const journal = await readFile(`${output}/live-probe.jsonl`, 'utf8');
    function parseEntry(line: string): unknown {
      return JSON.parse(line);
    }
    const trimmedJournal = journal.trim();
    const lines = trimmedJournal.split('\n');
    const entries = lines.map(parseEntry);
    assert.deepEqual(entries, [
      { name: 'policy', value: { revision: 1, contact: '[EMAIL REDACTED]' } },
      { name: 'policy', value: { revision: 2, contact: '[EMAIL REDACTED]' } },
    ]);
    const summary = await readFile(`${output}/live-probe.json`, 'utf8');
    assert.doesNotMatch(summary, /fixture@example/u);
    for (const file of ['live-probe.json', 'live-probe.jsonl']) {
      const details = await stat(join(output, file));
      assert.equal(details.mode & 0o777, 0o600);
    }
    function startAgain() {
      createStageBCollector(output);
    }
    assert.throws(startAgain, /keep earlier evidence/u);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}
test('keeps earlier observations private and refuses to overwrite an existing run',
  keepsEarlierObservationsAndRedactsEmail);

async function retainsRejectedReadbackWithoutRemovingFields() {
  const { createStageBCollector } = await import('./stage-b-collector.ts');
  const { readStageBQuote } = await import('./stage-b-readback.ts');
  const { createServer } = await import('node:http');
  const output = await mkdtemp(join(tmpdir(), 'stage-b-invalid-readback-'));
  const socket = join(output, 'demo.sock');
  const value = { quoteId: 'DEMO-001', amountCents: 12500, slot: 'morning',
    effectCount: 0, unexpected: 'Keep the complete original response' };
  const body = JSON.stringify({ result: { structuredContent: value } });
  function handle(request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse) {
    request.resume();
    response.end(body);
  }
  const server = createServer(handle);
  server.listen(socket);
  await once(server, 'listening');
  const collector = createStageBCollector(output);
  async function read() {
    await readStageBQuote(collector, socket, 'revision', 'before');
  }
  try {
    await assert.rejects(read);
    const saved = JSON.parse(await readFile(`${output}/live-probe.json`, 'utf8')) as {
      beforeResponse: { body: string };
    };
    assert.equal(saved.beforeResponse.body, body);
    assert(!Object.hasOwn(saved, 'before'));
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    await rm(output, { recursive: true, force: true });
  }
}
test('refuses unexpected readback fields and still saves the original response',
  retainsRejectedReadbackWithoutRemovingFields);
