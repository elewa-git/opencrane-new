import { connectNats, createEventStore } from '@opencrane/event-store';
import { lostReplyStore } from '@opencrane/event-store/testing';
import { pgDb } from '@opencrane/projections';
import { Pool } from 'pg';
import * as models from '@opencrane/models';
import { ownershipCommand } from '../../src/members/ownership.ts';
import type { Binding } from '@opencrane/authz';
import type { EventEnvelope } from '@opencrane/events';

const connection = await connectNats();
const store = await createEventStore(connection);
const binding: Binding = JSON.parse(process.env['TEST_BINDING']!);
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
      const lost = await lostReplyStore(connection);
      if (message.operation === 'lost_confirmation') lost.loseNextReply();
      const handler = models.ownershipConfirmationHandler(lost.store);
      await handler.handle(message.input as EventEnvelope, pgDb(pool));
      result = 'confirmed';
    }
    process.send!({ result });
  } catch (error) {
    process.send!({ error: error instanceof Error ? error.message : String(error) });
  }
}
function receive(message: Parameters<typeof handle>[0]) {
  void handle(message);
}
process.on('message', receive);
process.send!({ ready: true });
