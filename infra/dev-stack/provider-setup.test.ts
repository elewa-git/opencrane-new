import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { setupProvider } from './provider-setup.ts';

async function recordsSetup() {
  const expected = ['create', 'changes', 'key', 'changes', 'reachability', 'changes',
    'quote', 'test', 'changes', 'models', 'changes', 'bindings', 'select', 'changes',
    'drain', 'start', 'changes', 'drain', 'switch-on', 'changes'];
  for (const refusal of [-2, -1, ...expected.keys()]) {
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
      if (step === 'create') {
        assert.equal(input.provider, 'openai');
        assert.equal(input.expectedRevision, 0);
        assert.equal(Object.hasOwn(input, 'upstream'), false);
      }
      if (step === 'test') {
        assert.equal(input.consent, true);
        assert.equal(input.priceTableId, 'price');
        assert.equal(input.reservedCents, 1);
      }
      if (step === 'select') {
        assert.equal(input.kind, 'silo_default');
        assert.equal(input.expectedBindingSequence, 2);
        assert.equal(input.expectedProviderSequence, 4);
      }
      response.setHeader('content-type', 'application/json');
      if (steps.length - 1 === refusal) {
        response.writeHead(403);
        response.end('private reply with sensitive-value and /private/location');
        return;
      }
      const result = { status: 'appended', revision: 3, sequence: 4,
        expectedProviderSequence: 4, priceTableId: 'price', reservedCents: 1,
        rows: [{ kind: 'silo_default', position: 2 }],
        projection: { content: 'current', iam: 'current' },
        outcome: refusal === -2 && steps.length === 6 ? 'fail' : 'pass' };
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
          const status = refusal === -2 ? 'refused' : '403';
          assert.match(error.message, new RegExp(`^Provider setup [a-z-]+: ${status}$`, 'u'));
          assert.equal(error.stack!.includes('sensitive-value'), false);
          assert.equal(error.stack!.includes('/private/location'), false);
          return true;
        }
        await assert.rejects(run, safeError);
      }
      let expectedSteps = expected;
      if (refusal === -2) expectedSteps = expected.slice(0, 6);
      if (refusal >= 0) expectedSteps = expected.slice(0, refusal + 1);
      assert.deepEqual(steps, expectedSteps);
    } finally {
      server.closeAllConnections();
      const closed = once(server, 'close');
      server.close();
      await closed;
    }
  }
}
test('provider setup uses ordered authenticated product calls and stops at each refusal', recordsSetup);

async function waitsForSeededDefault() {
  let bindingReads = 0;
  let selections = 0;
  async function handle(request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse) {
    let contents = '';
    for await (const chunk of request) contents += String(chunk);
    const input = contents ? JSON.parse(contents) : {};
    response.setHeader('content-type', 'application/json');
    const isBindings = request.url === '/api/org/providers/dev-stub/bindings';
    if (isBindings && request.method === 'GET') {
      bindingReads++;
      const rows = bindingReads === 1 ? [] : [{ kind: 'silo_default', position: 5 }];
      const expectedProviderSequence = bindingReads === 1 ? 4 : 5;
      response.end(JSON.stringify({ rows, expectedProviderSequence }));
      return;
    }
    if (input.action === 'select') {
      selections++;
      // Model selection also schedules the product's first default provider binding.
      if (input.expectedProviderSequence !== 5 || input.expectedBindingSequence !== 5) {
        response.writeHead(409);
        response.end(JSON.stringify({ status: 'conflict' }));
        return;
      }
    }
    const result = { status: 'appended', revision: 3, sequence: 6,
      expectedProviderSequence: 5, priceTableId: 'price', reservedCents: 1,
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
    await setupProvider(options);
    assert.equal(bindingReads, 2);
    assert.equal(selections, 1, 'Wait for the scheduled binding before the single owner selection');
  } finally {
    server.closeAllConnections();
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
}
test('waits for the first provider binding before explicitly selecting the default',
  waitsForSeededDefault);

async function refusesUnsafeReplies() {
  for (const failure of ['redirect', 'transport', 'json']) {
    let requests = 0;
    function handle(request: import('node:http').IncomingMessage,
      response: import('node:http').ServerResponse) {
      requests++;
      request.resume();
      if (failure === 'transport') {
        request.socket.destroy(new Error('sensitive-value /private/location'));
        return;
      }
      if (failure === 'redirect') {
        response.writeHead(307, { location: '/private/location?sensitive-value' });
      }
      response.end('sensitive-value /private/location');
    }
    const server = createServer(handle);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const options = { server: `http://127.0.0.1:${address.port}`, origin: 'http://dev-only',
      cookie: 'session=dev-only', silo: 'dev', value: 'sensitive-value' };
    async function run() { await setupProvider(options); }
    function safeError(error: unknown) {
      assert(error instanceof Error);
      const reason = failure === 'json' ? 'invalid' : 'unavailable';
      assert.equal(error.message, `Provider setup create: ${reason}`);
      assert.equal(error.stack!.includes('sensitive-value'), false);
      assert.equal(error.stack!.includes('/private/location'), false);
      assert.equal(error.cause, undefined);
      return true;
    }
    try {
      await assert.rejects(run, safeError);
      assert.equal(requests, 1, 'A failed setup must neither follow a redirect nor continue');
    } finally {
      server.closeAllConnections();
      const closed = once(server, 'close');
      server.close();
      await closed;
    }
  }
}
test('setup refuses redirects and sanitises transport and JSON errors', refusesUnsafeReplies);
