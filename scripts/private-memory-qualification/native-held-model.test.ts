import { request } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { heldModel } from './native-checks.ts';

async function closedResponseCannotProveHeldTurn(): Promise<void> {
  const model = await heldModel();
  model.bind('test-caller', 'test-thread');
  const options = {
    hostname: '127.0.0.1', port: 8080, path: '/v1/responses', method: 'POST',
    headers: { authorization: 'Bearer test-caller', 'session-id': 'test-thread' },
  };
  const client = request(options);
  try {
    const response = await new Promise<import('node:http').IncomingMessage>(
      function received(resolve): void {
        client.once('response', resolve);
        client.end();
      },
    );
    await expect(model.wait()).resolves.toBeUndefined();
    response.destroy();
    await new Promise<void>(function closed(resolve): void {
      response.once('close', resolve);
    });
    let serverSawClosure = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        model.assertHeld();
      } catch {
        serverSawClosure = true;
        break;
      }
      await delay(10);
    }
    expect(serverSawClosure).toBe(true);
    const nextWait = model.wait();
    function settled(): string {
      return 'settled';
    }
    const waitOutcome = nextWait.then(settled, settled);
    const outcome = await Promise.race([waitOutcome, delay(50, 'pending')]);
    expect(outcome).toBe('pending');
    expect(() => model.assertHeld()).toThrow('native_turn_not_held');

    const nextClient = request(options);
    try {
      const nextResponse = await new Promise<import('node:http').IncomingMessage>(
        function receivedNext(resolve): void {
          nextClient.once('response', resolve);
          nextClient.end();
        },
      );
      await expect(nextWait).resolves.toBeUndefined();
      nextResponse.destroy();
    } finally {
      nextClient.destroy();
    }
  } finally {
    client.destroy();
    await model.close();
  }
}

it('refuses a held request after its response closes', closedResponseCannotProveHeldTurn);

function modelRequest(body: object): Promise<import('node:http').IncomingMessage> {
  const options = {
    hostname: '127.0.0.1', port: 8080, path: '/v1/responses', method: 'POST',
    headers: { authorization: 'Bearer caller', 'session-id': 'thread' },
  };
  const client = request(options);
  function received(resolve: (response: import('node:http').IncomingMessage) => void): void {
    client.once('response', resolve);
    client.end(JSON.stringify(body));
  }
  return new Promise(received);
}

async function nativeRefusalNeedsMatchingOutput(): Promise<void> {
  const model = await heldModel();
  model.bind('caller', 'thread');
  let first: import('node:http').IncomingMessage | undefined;
  let second: import('node:http').IncomingMessage | undefined;
  try {
    first = await modelRequest({ input: [], tools: [] });
    first.resume();
    await model.wait();
    const callId = 'call_qualification';
    const item = { type: 'function_call', id: 'tool_qualification',
      name: 'exec_command', call_id: callId, arguments: '{}' };
    const completed = model.completeTool(item, callId);
    await once(first, 'end');
    second = await modelRequest({ input: [{ type: 'function_call_output',
      call_id: callId, output: 'Error: unknown tool' }], tools: [] });
    second.resume();
    await expect(completed).resolves.toBe(true);
    model.assertHeld();
  } finally {
    first?.destroy();
    second?.destroy();
    await model.close();
  }
}
it('counts only a matching native refusal while the next request is held',
  nativeRefusalNeedsMatchingOutput);
