import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { setupProvider } from './provider-setup.ts';

async function recordsSetup() {
  const expected = ['create', 'changes', 'key', 'changes', 'reachability', 'changes',
    'quote', 'test', 'changes', 'models', 'changes', 'bindings', 'select', 'changes',
    'drain', 'start', 'changes', 'drain', 'switch-on', 'changes'];
  for (const refusal of [-1, ...expected.keys()]) {
    const steps: string[] = [];
    async function handle(request: import('node:http').IncomingMessage,
      response: import('node:http').ServerResponse) {
      let contents = '';
      for await (const chunk of request) contents += String(chunk);
      const input = contents ? JSON.parse(contents) : {};
      assert.equal(request.headers.cookie, 'session=dev-only');
      if (request.method === 'POST') assert.equal(request.headers.origin, 'http://dev-only');
      let step = input.action ?? request.url!.split('/').at(-1);
      if (request.url!.includes('/changes/')) step = 'changes';
      if (request.url!.includes('?model=')) step = 'quote';
      steps.push(step);
      response.setHeader('content-type', 'application/json');
      if (steps.length - 1 === refusal) {
        response.writeHead(403);
        response.end('private reply with sensitive-value and /private/location');
        return;
      }
      const result = { status: 'appended', revision: 3, sequence: 4,
        expectedProviderSequence: 4, priceTableId: 'price', reservedCents: 1,
        rows: [{ kind: 'silo_default', position: 2 }],
        projection: { content: 'current', iam: 'current' }, outcome: 'pass' };
      response.end(JSON.stringify(result));
    }
    const server = createServer(handle);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const options = { server: `http://127.0.0.1:${address.port}`, origin: 'http://dev-only',
      cookie: 'session=dev-only', silo: 'dev', value: 'sensitive-value' };
    try {
      if (refusal === -1) await setupProvider(options);
      else {
        async function run() { await setupProvider(options); }
        function safeError(error: unknown) {
          assert(error instanceof Error);
          assert.match(error.message, /^Provider setup [a-z-]+: 403$/u);
          assert.equal(error.stack!.includes('sensitive-value'), false);
          assert.equal(error.stack!.includes('/private/location'), false);
          return true;
        }
        await assert.rejects(run, safeError);
      }
      assert.deepEqual(steps, refusal === -1 ? expected : expected.slice(0, refusal + 1));
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
}
test('provider setup uses ordered authenticated product calls and stops at each refusal', recordsSetup);
