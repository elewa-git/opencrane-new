import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { request } from 'playwright';
import { z } from 'zod';
import { createSharedScreenshotChat } from './screenshot-shared-chat.ts';

const childStart = z.object({ requestId: z.string() });
const childId = 'shared-child';

async function provesSavedChildStart() {
  let starts = 0;
  let statusChecks = 0;
  let sharedReads = 0;
  let requestId = '';
  async function respond(incoming: IncomingMessage, response: ServerResponse) {
    const url = incoming.url ?? '';
    if (incoming.method === 'GET') {
      if (url.endsWith('/messages')) {
        sharedReads++;
        assert.equal(incoming.headers['x-test-reader'], 'other-participant');
        return reply(response, 200, { rows: [] });
      }
      assert(url.endsWith(`/children/${requestId}`));
      statusChecks++;
      return reply(response, 200, { state: 'queued', requestId, childConversationId: childId });
    }
    if (url.endsWith('/child-review')) {
      return reply(response, 200, { review: 'saved-review' });
    }
    if (url.endsWith('/children')) {
      starts++;
      let body = '';
      for await (const chunk of incoming) body += String(chunk);
      requestId = childStart.parse(JSON.parse(body)).requestId;
      return reply(response, 425, { status: 'access_applying' });
    }
    reply(response, 200, {});
  }
  function serve(incoming: IncomingMessage, response: ServerResponse) {
    function fault(error: unknown) {
      reply(response, 500, { error: String(error) });
    }
    void respond(incoming, response).catch(fault);
  }
  const server = createServer(serve);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const requester = await request.newContext();
  const reader = await request.newContext({
    extraHTTPHeaders: { 'x-test-reader': 'other-participant' },
  });
  async function until(check: () => Promise<boolean>) {
    assert(await check(), 'The saved request and chat are available');
  }
  function conversation() {
    return Promise.resolve({ allowed: true, status: 'ok' as const });
  }
  try {
    const fixture = {
      requester: { request: requester }, reader: { request: reader }, origin,
      assistant: { assistantId: 'team-assistant', groupId: 'group' },
      requesterId: 'requester', readerId: 'other-participant',
      authorisation: { conversation }, until,
    };
    assert.equal(await createSharedScreenshotChat(fixture), childId);
    assert.equal(starts, 1, 'Send the child command once');
    assert.equal(statusChecks, 1, 'Read the saved request by its original id');
    assert.equal(sharedReads, 1, 'Have the other participant read the saved chat');
  } finally {
    await requester.dispose();
    await reader.dispose();
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
}

function reply(response: ServerResponse, status: number, body: object) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

void test('checks the saved child request when the start reply is still applying',
  provesSavedChildStart);
