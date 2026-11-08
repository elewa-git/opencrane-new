import { request } from 'node:http';
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
