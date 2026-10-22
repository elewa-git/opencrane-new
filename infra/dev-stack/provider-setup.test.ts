import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
        assert.equal(input.providerId, 'dev-openai');
        assert.equal(input.name, 'OpenAI demo');
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
      cookie: 'session=dev-only', silo: 'dev', value: 'sensitive-value', real: true };
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

async function waitsForSeededDefault(loseReply = false, absent = false, unavailable = false) {
  let saves = 0;
  let savedCommand = '';
  let recovered = false;
  let bindingReads = 0;
  let selections = 0;
  let paidTests = 0;
  async function handle(request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse) {
    let contents = '';
    for await (const chunk of request) contents += String(chunk);
    const input = contents ? JSON.parse(contents) : {};
    response.setHeader('content-type', 'application/json');
    if (input.action === 'test') {
      paidTests += 1;
    }
    if (request.method === 'POST' && request.url?.endsWith('/key')) {
      saves++;
      savedCommand = input.commandId;
      if (loseReply) {
        request.socket.destroy();
        return;
      }
    }
    if (savedCommand && request.url?.endsWith(`/changes/${savedCommand}`)) {
      recovered = true;
      if (absent) {
        response.writeHead(404);
        response.end('sensitive-value /private/location');
        return;
      }
    }
    const isBindings = request.url === '/api/org/providers/dev-stub/bindings';
    if (isBindings && request.method === 'GET') {
      bindingReads++;
      if (unavailable && bindingReads === 1) {
        response.writeHead(503);
        response.end('sensitive-value /private/location');
        return;
      }
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
    const result = { status: 'appended', operation: 'provider.key_saved', revision: 3, sequence: 6,
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
    if (absent) {
      async function run() { await setupProvider(options); }
      await assert.rejects(run, { message: 'Provider setup save: 404' });
      assert.equal(saves, 1);
      assert.equal(selections, 0);
      return;
    }
    await setupProvider(options);
    assert(recovered, 'Read the original save command');
    assert.equal(saves, 1, 'An unknown write is never sent twice');
    assert.equal(bindingReads, 2);
    assert.equal(paidTests, 1, 'The binding read never repeats the paid test');
    assert.equal(selections, 1, 'Wait for the scheduled binding before the single owner selection');
  } finally {
    server.closeAllConnections();
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
}
function seededDefaultTest() {
  return waitsForSeededDefault();
}
function lostReplyTest() {
  return waitsForSeededDefault(true);
}
function absentReceiptTest() {
  return waitsForSeededDefault(true, true);
}

function temporaryBindingTest() {
  return waitsForSeededDefault(false, false, true);
}

test('waits for a temporarily unavailable provider binding without repeating writes',
  temporaryBindingTest);
test('waits for the first provider binding before explicitly selecting the default', seededDefaultTest);
test('a lost save reply is recovered by reading its original receipt', lostReplyTest);
test('an absent receipt after a lost response never repeats the unknown write', absentReceiptTest);

async function retriesApplyingCreate() {
  const attempts: string[] = [];
  const methods: string[] = [];
  async function handle(request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse) {
    let contents = '';
    for await (const chunk of request) contents += String(chunk);
    methods.push(`${request.method} ${request.url}`);
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST' && request.url === '/api/org/providers') {
      attempts.push(contents);
      if (attempts.length === 1) {
        response.writeHead(425);
        response.end(JSON.stringify({ status: 'access_applying' }));
        return;
      }
      response.end(JSON.stringify({ status: 'appended', revision: 1 }));
      return;
    }
    if (request.url?.includes('/changes/')) {
      response.end(JSON.stringify({ revision: 1,
        projection: { content: 'current', iam: 'current' } }));
      return;
    }
    response.writeHead(403);
    response.end('sensitive-value /private/location');
  }
  const server = createServer(handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const options = { server: `http://127.0.0.1:${address.port}`, origin: 'http://dev-only',
    cookie: 'session=dev-only', silo: 'dev', value: 'sensitive-value' };
  async function run() {
    await setupProvider(options);
  }
  try {
    await assert.rejects(run, { message: 'Provider setup save: 403' });
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1], attempts[0], 'Retry the exact command, including its id');
    assert.deepEqual(methods.slice(0, 2), [
      'POST /api/org/providers', 'POST /api/org/providers',
    ]);
    assert.match(methods[2]!, /^GET \/api\/org\/providers\/dev-stub\/changes\//u);
    assert.equal(methods.length, 4);
  } finally {
    server.closeAllConnections();
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
}
test('setup retries the exact create only when the product reports access still applying',
  retriesApplyingCreate);

async function refusesUnclearApplyingReplies() {
  for (const failure of ['wrong-status', 'invalid', 'unavailable']) {
    const methods: string[] = [];
    function handle(request: import('node:http').IncomingMessage,
      response: import('node:http').ServerResponse) {
      methods.push(request.method!);
      request.resume();
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET') {
        response.writeHead(404);
      } else {
        response.writeHead(failure === 'unavailable' ? 503 : 425);
      }
      const body = failure === 'invalid' ? 'sensitive-value /private/location'
        : JSON.stringify({ status: 'unavailable' });
      response.end(body);
    }
    const server = createServer(handle);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const options = { server: `http://127.0.0.1:${address.port}`, origin: 'http://dev-only',
      cookie: 'session=dev-only', silo: 'dev', value: 'sensitive-value' };
    async function run() {
      await setupProvider(options);
    }
    try {
      const code = failure === 'unavailable' ? 404 : 425;
      await assert.rejects(run, { message: `Provider setup create: ${code}` });
      const expected = failure === 'unavailable' ? ['POST', 'GET'] : ['POST'];
      assert.deepEqual(methods, expected, 'Only a definite access-applying reply permits retry');
    } finally {
      server.closeAllConnections();
      const closed = once(server, 'close');
      server.close();
      await closed;
    }
  }
}
test('unclear 425 replies and an unknown 503 write never repeat the create',
  refusesUnclearApplyingReplies);

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
      assert.equal(requests, 2, 'A lost reply permits only the original receipt GET');
    } finally {
      server.closeAllConnections();
      const closed = once(server, 'close');
      server.close();
      await closed;
    }
  }
}
test('setup refuses redirects and sanitises transport and JSON errors', refusesUnsafeReplies);

async function refusesMissingCredentials() {
  const folder = await mkdtemp(`${tmpdir()}/provider-input-`);
  try {
    for (const contents of [undefined, '', '  \n']) {
      if (contents !== undefined) await writeFile(`${folder}/synthetic-canary`, contents);
      const script = `
        import { setupDevProvider } from './infra/dev-stack/provider-setup.ts';
        try { await setupDevProvider({}, process.argv[1]); }
        catch (error) { console.log(error.message); }
      `;
      // Isolate all setup files, including when a regression ignores the supplied path.
      const env = { ...process.env, DEV_STACK_ID: 'owner', DEV_STACK_DIR: folder };
      const args = ['--experimental-strip-types', '--input-type=module', '-e', script,
        `${folder}/synthetic-canary`];
      const result = await promisify(execFile)(process.execPath, args, { env });
      assert.equal(result.stdout.trim(), 'Provider setup preparation: unavailable');
      assert.equal(result.stderr, '');
      const files = await readdir(folder);
      assert.equal(files.includes('model-managed-stub'), false);

    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
test('private setup refuses missing and empty files without disclosing their locations',
  refusesMissingCredentials);
