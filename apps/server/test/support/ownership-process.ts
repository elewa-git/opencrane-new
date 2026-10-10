import { connectNats, createEventStore } from '@opencrane/event-store';
import { lostReplyStore } from '@opencrane/event-store/testing';
import { pgDb } from '@opencrane/projections';
import { Pool } from 'pg';
import { dispatch, HandlerRuntime, provisionDispatcher } from '@opencrane/handlers';
import { createLogger } from '@opencrane/observability';
import { until } from '@opencrane/authz/testing';
import * as models from '@opencrane/models';
import { ownershipCommand } from '../../src/members/ownership.ts';
import { parseEventByType } from '@opencrane/events';
import { z } from 'zod';

const connection = await connectNats();
const store = await createEventStore(connection);
const bindingSchema = z.object({ silo: z.string(), apiUrl: z.string(),
  storeId: z.string(), authorizationModelId: z.string() });
const binding = bindingSchema.parse(JSON.parse(process.env['TEST_BINDING']!));
const pool = new Pool({ connectionString: process.env['TEST_DATABASE'] });
let removal: Parameters<typeof store.append>[0];
async function handle(message: { operation: string; input: unknown; actor?: string }) {
  try {
    let result: unknown;
    if (message.operation === 'command') {
      result = await ownershipCommand(store, binding, message.actor ?? 'alice', message.input);
    } else if (message.operation === 'prepare_removal') {
      const membership = await models.currentMembership(store, 'test', 'bob');
      if (membership.role === 'owner') throw new Error('owner_removal_refused');
      removal = { event: message.input, expectedSequence: await store.head('member-bob') };
      result = 'prepared';
    } else if (message.operation === 'remove') {
      result = await store.append(removal);
    } else {
      const request = parseEventByType(message.input);
      if (!request.success) throw new Error('Invalid appointment');
      const eventId = request.event.id;
      const lost = await lostReplyStore(connection);
      if (message.operation === 'lost_confirmation') lost.loseNextReply();
      const handler = models.ownershipConfirmationHandler(lost.store);
      const db = pgDb(pool);
      const logger = createLogger('confirmation-process', { level: 'silent' });
      const runtime = new HandlerRuntime({ db, logger, silo: 'test', handlers: [handler] });
      const dispatcherEnv = z.record(z.string(), z.string());
      const env = dispatcherEnv.parse(JSON.parse(process.env['TEST_DISPATCHER']!));
      const dispatcher = await connectNats(env);
      const stop = new AbortController();
      await runtime.start();
      await provisionDispatcher(connection);
      async function work() { await runtime.work(); }
      const running = dispatch(dispatcher, runtime, stop.signal, work);
      async function applied() {
        const receipt = await db.query('SELECT event_id FROM handler_receipts WHERE event_id = $1',
          [eventId]);
        return receipt.rows.length > 0;
      }
      try {
        await until(applied);
      } finally {
        stop.abort();
        await running.catch(dispatchStopped);
        await runtime.stop();
        await dispatcher.close();
      }
      result = 'confirmed';
    }
    process.send!({ result });
  } catch (error) {
    process.send!({ error: error instanceof Error ? error.message : String(error) });
  }
}
function dispatchStopped(error: unknown) {
  if (!(error instanceof Error && error.name === 'AbortError')) throw error;
}
function receive(message: Parameters<typeof handle>[0]) {
  void handle(message);
}
process.on('message', receive);
process.send!({ ready: true });
