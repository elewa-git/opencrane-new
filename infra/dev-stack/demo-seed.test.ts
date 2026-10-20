import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { seedDemo, demoStackId } from './demo-seed.ts';

async function recordingApi() {
  const directory = await mkdtemp(`${tmpdir()}/demo-seed-`);
  const writes: Array<Record<string, unknown>> = [];
  const receipts = new Map<string, unknown>();
  let loseReply = false;
  let hideReceipt = false;
  let memberMissing = false;
  async function respond(request: IncomingMessage, response: ServerResponse) {
    assert.equal(request.headers.cookie, 'synthetic-session');
    const path = request.url!;
    response.setHeader('content-type', 'application/json');
    if (path.startsWith('/api/members/')) {
      response.statusCode = memberMissing ? 404 : 200;
      response.end(JSON.stringify({ memberId: path.split('/').at(-1), role: 'member' }));
      return;
    }
    if (request.method === 'GET') {
      const id = path.split('/').at(-1)!;
      const receipt = hideReceipt ? undefined : receipts.get(id);
      response.statusCode = receipt ? 200 : 404;
      response.end(JSON.stringify(receipt ?? { status: 'not_found' }));
      return;
    }
    assert.equal(request.headers.origin, origin);
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as Record<string, unknown>;
    writes.push(body);
    const receipt = { status: 'appended', sequence: writes.length, changeId: 'fixture',
      projection: { content: 'current', iam: 'current' } };
    receipts.set(String(body['commandId']), receipt);
    if (loseReply) {
      response.destroy();
      return;
    }
    response.end(JSON.stringify(receipt));
  }
  function handler(request: IncomingMessage, response: ServerResponse) {
    void respond(request, response);
  }
  const server = createServer(handler);
  function listen(resolve: () => void) {
    server.listen(0, '127.0.0.1', resolve);
  }
  await new Promise<void>(listen);
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  function stop(resolve: () => void) {
    function done() { resolve(); }
    server.close(done);
  }
  async function close() {
    server.closeAllConnections();
    await new Promise<void>(stop);
    await rm(directory, { recursive: true, force: true });
  }
  return { writes, options: { origin, cookie: 'synthetic-session', directory }, close,
    loseReply() { loseReply = true; }, hideReceipt() { hideReceipt = true; },
    missingMember() { memberMissing = true; } };
}

async function repeatsWithoutCreatingMore() {
  const fixture = await recordingApi();
  try {
    await seedDemo(fixture.options);
    const original = structuredClone(fixture.writes);
    assert.equal(original.length, 7);
    const groups = original.slice(0, 2);
    const names = groups.map(readName);
    assert.deepEqual(names, ['Acacia Trading', 'Kijani Logistics']);
    assert.equal(original.at(-1)?.['assistantId'], 'team-demo-acacia');
    await seedDemo(fixture.options);
    assert.deepEqual(fixture.writes, original);
  } finally {
    await fixture.close();
  }
}
function readName(command: Record<string, unknown>) { return command['name']; }

async function reconcilesLostReplies() {
  const fixture = await recordingApi();
  try {
    fixture.loseReply();
    await seedDemo(fixture.options);
    await seedDemo(fixture.options);
    assert.equal(fixture.writes.length, 7);
  } finally {
    await fixture.close();
  }
}

async function retainsUnknownRequests() {
  const fixture = await recordingApi();
  try {
    fixture.loseReply();
    fixture.hideReceipt();
    await assert.rejects(seedDemo(fixture.options), /^Error: Demo seed outcome unknown$/u);
    await assert.rejects(seedDemo(fixture.options), /^Error: Demo seed outcome unknown$/u);
    assert.equal(fixture.writes.length, 1);
  } finally {
    await fixture.close();
  }
}

async function refusesMissingPeople() {
  const fixture = await recordingApi();
  try {
    fixture.missingMember();
    await assert.rejects(seedDemo(fixture.options), /^Error: Demo seed request refused$/u);
    assert.equal(fixture.writes.length, 0);
  } finally {
    await fixture.close();
  }
}

function refusesOwnerAndMissingIds() {
  for (const id of [undefined, '', 'owner', '3']) {
    function reject() { demoStackId(id); }
    assert.throws(reject);
  }
  assert.equal(demoStackId('1'), '1');
  assert.equal(demoStackId('2'), '2');
  assert.equal(demoStackId('owner', true), 'owner');
  function rejectMissing() { demoStackId(undefined, true); }
  assert.throws(rejectMissing);
}

test('seed keeps the same people, two groups and assistant on repeat', repeatsWithoutCreatingMore);
test('seed reads original receipts after lost replies without another POST', reconcilesLostReplies);
test('unknown writes stay unknown across reruns and never duplicate', retainsUnknownRequests);
test('seed refuses missing slot people before any write', refusesMissingPeople);
test('automated seed refuses owner and missing ids; owner use is explicit', refusesOwnerAndMissingIds);
