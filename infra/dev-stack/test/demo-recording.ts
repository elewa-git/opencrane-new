import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

export async function demoRecording() {
  const directory = await mkdtemp(`${tmpdir()}/demo-recording-`);
  const budget = { sequence: 1, ceilingCents: 100, dailyCeilingCents: 80,
    todayCents: 0, monthCents: 0, reservedCents: 0, defaultPayingGroupId: 'company',
    periodStart: null, ceilings: [] };
  const writes: Array<Record<string, unknown>> = [];
  const receipts = new Map<string, unknown>();
  let failPreparation = true;
  let refuseRestore = false;
  async function respond(request: IncomingMessage, response: ServerResponse) {
    assert.equal(request.headers.cookie, 'synthetic-session');
    const path = request.url!;
    let result: unknown = {};
    if (request.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const command = JSON.parse(bytes.toString());
      writes.push(command);
      if (path === '/api/org/models') {
        if (refuseRestore && command.ceilingCents === 100) {
          response.statusCode = 503;
          response.end('{}');
          return;
        }
        assert.equal(command.expectedSequence, budget.sequence);
        budget.sequence += 1;
        budget.ceilingCents = command.ceilingCents;
        budget.dailyCeilingCents = command.dailyCeilingCents;
      }
      const receipt = { status: 'appended', projection: { content: 'current', iam: 'current' } };
      receipts.set(command.commandId ?? command.id, receipt);
    } else if (path === '/api/org/models') {
      result = { budget };
    } else if (path === '/api/chat') {
      if (failPreparation) response.statusCode = 503;
      else result = { assistantId: 'personal-owner' };
    } else if (path.endsWith('/files')) {
      result = { rows: [{ name: 'supplier.pdf', status: 'delivered' }] };
    } else if (path.includes('/changes/')) {
      result = receipts.get(path.split('/').at(-1)!);
      if (!result) {
        response.statusCode = 404;
        result = { status: 'unknown' };
      }
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
  function allowPreparation() { failPreparation = false; }
  function failRestore(value: boolean) { refuseRestore = value; }
  async function close() {
    server.closeAllConnections();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
  return { options, budget, writes, allowPreparation, failRestore, close };
}
