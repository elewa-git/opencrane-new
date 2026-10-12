import { once } from 'node:events';
import { connectEventStore } from '@opencrane/event-store';
import { connectProjectionDb } from '@opencrane/projections';
import { scanNightlyMemory } from '../../src/nightly-memory.ts';

const connection = await connectEventStore();
function databaseFailed(error: Error) {
  throw error;
}
const database = connectProjectionDb(process.env['NIGHTLY_TEST_DATABASE']!, databaseFailed);
const store = connection.store;
const originalHead = store.head.bind(store);
async function capturedHead() {
  const position = await originalHead();
  const release = once(process, 'message');
  process.send?.('ready');
  await release;
  return position;
}
store.head = capturedHead;
try {
  const occurrence = new Date('2026-10-12T02:00:00Z');
  function selectedTime() {
    return occurrence;
  }
  await scanNightlyMemory(database.db, store, 'test', occurrence, selectedTime);
} finally {
  await database.close();
  await connection.close();
  process.disconnect();
}
