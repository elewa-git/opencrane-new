import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { prepareDemo } from './demo-prepare.ts';

async function recordingRun(hideReceipts: boolean, hideConversationReceipt = false) {
  const directory = await mkdtemp(`${tmpdir()}/demo-prepare-`);
  const writes: string[] = [];
  const receipts = new Map<string, unknown>();
  let uploaded = false;
  let ceilingCents = 2000;
  async function respond(request: IncomingMessage, response: ServerResponse) {
    assert.equal(request.headers.cookie, 'synthetic-session');
    const path = request.url!;
    let result: unknown = {};
    if (request.method === 'POST') {
      writes.push(path);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      if (path.endsWith('/files')) {
        assert.equal(request.headers['x-file-name'], 'supplier.pdf');
        const checked = await readFile('infra/dev-stack/fixtures/supplier.pdf');
        assert(bytes.equals(checked));
        assert.match(checked.toString(), /Total EUR 1234.56; delivery 17 November 2026/u);
        uploaded = true;
      } else {
        const command = JSON.parse(bytes.toString());
        if (path === '/api/org/models') {
          assert.equal(command.scope, 'global');
          assert.equal(command.ceilingCents, 700);
          assert.equal(command.dailyCeilingCents, 700);
          ceilingCents = command.ceilingCents;
        } else {
          assert.equal(command.assistantId, 'personal-owner');
          assert.equal(command.conversationId, 'demo-supplier-v1');
        }
        receipts.set(command.commandId ?? command.id, { status: 'appended',
          receipt: { sequence: 2 }, projection: { content: 'current', iam: 'current' } });
      }
      response.destroy();
      return;
    }
    if (path === '/api/chat') result = { assistantId: 'personal-owner' };
    if (path === '/api/org/models') result = { budget: { sequence: 2, ceilingCents,
      dailyCeilingCents: ceilingCents, todayCents: 0, monthCents: 0, reservedCents: 0,
      defaultPayingGroupId: 'company', periodStart: null, ceilings: [] } };
    if (path.endsWith('/files')) result = { rows: uploaded
      ? [{ name: 'supplier.pdf', status: 'delivered', textPath: 'uploads/demo/supplier.pdf.md' }]
      : [] };
    if (path.includes('/changes/')) {
      const missingConversation = !receipts.has('demo-supplier-create-v1');
      if (path.startsWith('/api/conversations/') &&
          (missingConversation || hideConversationReceipt)) {
        response.statusCode = 403;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ status: 'refused' }));
        return;
      }
      result = hideReceipts ? { status: 'unknown' }
        : receipts.get(path.split('/').at(-1)!) ?? { status: 'unknown' };
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(result));
  }
  function handler(request: IncomingMessage, response: ServerResponse) {
    void respond(request, response);
  }
  const server = createServer(handler);
  function listen(resolve: () => void) { server.listen(0, '127.0.0.1', resolve); }
  await new Promise<void>(listen);
  const address = server.address();
  assert(address && typeof address !== 'string');
  const options = { directory, origin: `http://127.0.0.1:${address.port}`,
    cookie: 'synthetic-session' };
  try {
    if (hideConversationReceipt) {
      await assert.rejects(prepareDemo(options, 700), /receipt unavailable/u);
      await assert.rejects(prepareDemo(options, 700), /receipt unavailable/u);
      assert.deepEqual(writes, ['/api/org/models', '/api/conversations']);
      return;
    }
    if (hideReceipts) {
      await assert.rejects(prepareDemo(options, 700), /outcome unknown/u);
      await assert.rejects(prepareDemo(options, 700), /outcome unknown/u);
      assert.equal(writes.length, 1);
      return;
    }
    await prepareDemo(options, 700);
    await prepareDemo(options, 700);
    assert.deepEqual(writes, ['/api/org/models', '/api/conversations',
      '/api/conversations/demo-supplier-v1/files']);
    for (const invalid of [-1, 0, 2001, 2.5, NaN]) {
      await assert.rejects(prepareDemo(options, invalid));
    }
    assert.equal(writes.length, 3);
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function repeatsAfterLostReplies() { await recordingRun(false); }
async function keepsUnknownWrites() { await recordingRun(true); }
test('preparation never repeats a write when its receipt stays unknown', keepsUnknownWrites);

test('preparation keeps one scanned personal PDF and company cap after lost replies',
  repeatsAfterLostReplies);

async function keepsUnknownConversation() { await recordingRun(false, true); }
test('preparation never repeats conversation creation after its receipt is refused',
  keepsUnknownConversation);
