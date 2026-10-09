import { once } from 'node:events';
import { connectEventStore } from '@opencrane/event-store';
import { event } from '@opencrane/event-store/testing';
import type { EventEnvelope } from '@opencrane/events';
import { lifecycleHandlers } from '../src/lifecycle.ts';

const connected = await connectEventStore();
const joined: EventEnvelope = event('join-choice', 'member-alice', 'member.joined');
joined.data = {
  memberId: 'alice', email: 'alice@example.test', displayName: 'Alice',
  role: 'member', personalAssistant: 'provision',
};
function refuseSql(): Promise<never> {
  const error = new Error('Assistant creation must write through events alone');
  return Promise.reject(error);
}
const transaction = { query: refuseSql };
const createAssistant = lifecycleHandlers(connected.store)[0];
await createAssistant.handle(joined, transaction);
process.send?.('assistant-created');
// Wait for the parent to kill this delivery before it can acknowledge completion.
await once(process, 'disconnect');
await connected.close();
