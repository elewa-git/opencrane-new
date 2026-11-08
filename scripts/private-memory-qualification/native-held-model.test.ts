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
    await expect(model.wait()).rejects.toThrow('native_turn_not_held');
    expect(() => model.assertHeld()).toThrow('native_turn_not_held');
  } finally {
    client.destroy();
    await model.close();
  }
}

it('refuses a held request after its response closes', closedResponseCannotProveHeldTurn);
