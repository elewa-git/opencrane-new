import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { HandlerRuntime } from '@opencrane/handlers';
import { createLogger } from '@opencrane/observability';
import { pgDb } from '@opencrane/projections';
import { databases } from '@opencrane/authz/testing';
import { BudgetActor, envelope, history, priceTableId, settlementHandler } from '../src/index.ts';

async function lossNoOpHasReceipt() {
  const nats = await natsFixture();
  const storage = await databases();
  const db = pgDb(storage.queue);
  const actor = new BudgetActor(nats.store, 'test');
  await actor.start(100, 100, 'group');
  const loss = envelope('test', 'computer-assistant', 'computer.lost', {
    assistantId: 'assistant', computerId: 'computer' });
  await nats.store.append({ event: loss, expectedSequence: 0 });
  const reservationId = await actor.reserve({ model: 'gpt-6-luna', priceTableId,
    computerId: 'computer', assistantId: 'assistant', requesterId: 'alice',
    conversationId: 'chat', turnId: 'turn', threadId: 'thread', payingGroupId: 'group',
    contextDigest: '0'.repeat(64) }, 1);
  async function settle(_request: IncomingMessage, response: ServerResponse) {
    await actor.computerLostRecorded(loss.subject, loss.id);
    response.end('{}');
  }
  function request(request: IncomingMessage, response: ServerResponse) {
    function failed(error: unknown) {
      response.statusCode = 500;
      response.end(String(error));
    }
    void settle(request, response).catch(failed);
  }
  const server = createServer(request);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('No settlement server address');
  }
  const logger = createLogger('loss-backfill-test', { level: 'silent' });
  const handler = settlementHandler(`http://127.0.0.1:${address.port}`);
  const runtime = new HandlerRuntime({ db, logger, silo: 'test', handlers: [handler] });
  try {
    await runtime.start();
    await runtime.enqueue(handler, loss, db);
    await runtime.work(1);
    let received = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await db.query('SELECT * FROM handler_receipts WHERE event_id = $1', [loss.id]);
      if (result.rows.length) {
        received = true;
        break;
      }
      await delay(25);
    }
    expect(received).toBe(true);
    expect(await history(nats.store, `effect-${reservationId}`, 'test')).toEqual([]);
    expect(actor.state.reservations[0]?.settledCents).toBeUndefined();
  } finally {
    await runtime.stop();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    await storage.close();
    await nats.close();
  }
}
it.skipIf(!process.env['PG_TEST_URL'])(
  'an old loss leaves a current hold untouched and commits its handler receipt', lossNoOpHasReceipt);

async function supersededLossKeepsEarlierHold() {
  const nats = await natsFixture();
  const actor = new BudgetActor(nats.store, 'test');
  try {
    await actor.start(100, 100, 'group');
    const reservationId = await actor.reserve({ model: 'gpt-6-luna', priceTableId,
      computerId: 'computer', assistantId: 'assistant', requesterId: 'alice',
      conversationId: 'chat', turnId: 'turn', threadId: 'thread', payingGroupId: 'group',
      requestId: 'request',
      contextDigest: '0'.repeat(64) }, 1);
    const allowed = envelope('test', 'decision-request', 'decision.recorded', {
      requestId: 'request', route: 'model', outcome: 'allow', reason: 'model_allowed',
      contextDigest: '0'.repeat(64), permitId: reservationId });
    await nats.seed([allowed]);
    const loss = envelope('test', 'computer-assistant', 'computer.lost', {
      assistantId: 'assistant', computerId: 'computer' });
    const latest = envelope('test', loss.subject, 'computer.lost', {
      assistantId: 'assistant', computerId: 'computer' });
    await nats.seed([loss, latest]);
    await actor.computerLostRecorded(loss.subject, loss.id);
    expect(await history(nats.store, `effect-${reservationId}`, 'test')).toEqual([]);
    expect(actor.state.reservations[0]?.settledCents).toBeUndefined();
    await actor.computerLostRecorded(latest.subject, latest.id);
    const effects = await history(nats.store, `effect-${reservationId}`, 'test');
    expect(effects).toHaveLength(1);
    expect(effects[0]?.event).toMatchObject({ type: 'effect.uncertain',
      data: { permitId: reservationId, reason: 'computer_lost' } });
    expect(actor.state.reservations[0]?.settledCents).toBeUndefined();
  } finally {
    await nats.close();
  }
}
it('ignores a superseded loss for an earlier hold and records uncertainty only for the latest loss',
  supersededLossKeepsEarlierHold);
