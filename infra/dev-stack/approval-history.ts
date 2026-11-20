import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppendCommand, EventStore } from '@opencrane/event-store';
import type { MessagePostedData } from '@opencrane/events';
import { envelope } from '@opencrane/models';
import type { Query } from '@opencrane/projections';
import { completedApprovalMessage } from './approval-tool.ts';

export type ApprovalHistorySeed = {
  silo: string;
  data: MessagePostedData;
};

export async function seedApprovalHistory(store: EventStore, db: Query,
  input: ApprovalHistorySeed) {
  const subject = `conversation-${input.data.conversationId}`;
  let position = await store.head(subject);
  const messagesPerBatch = 10;
  const batchCount = 3_000 / messagesPerBatch;
  // Bound queued work while every projection processes the same saved events under load.
  for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
    for (let messageIndex = 0; messageIndex < messagesPerBatch; messageIndex++) {
      const event = envelope(input.silo, subject, 'message.posted', input.data);
      position = await appendApprovalMessage(store, event, position);
    }
    await waitForApprovalHistory(db, position);
    console.log(`PASS long-chat seed batch ${batchIndex + 1}/${batchCount} at position ${position}`);
  }
}

async function appendApprovalMessage(store: EventStore, message: ReturnType<typeof envelope>,
  position: number) {
  const records = completedApprovalMessage(message);
  for (const event of records) {
    const command: AppendCommand = { event, expectedSequence: position, historyChecked: true };
    const result = await store.append(command);
    assert.equal(result.status, 'appended', 'Seed each earlier chat record once');
    if (result.status !== 'appended') throw new Error('Chat seeding refused');
    position = result.sequence;
  }
  return position;
}

async function waitForApprovalHistory(db: Query, position: number) {
  const deadline = performance.now() + 30_000;
  while (true) {
    const saved = await db.query<{ sequence: string }>(
      "SELECT sequence FROM projection_checkpoints WHERE name='conversations'");
    const checkpoint = Number(saved.rows[0]?.sequence);
    if (checkpoint >= position) break;
    assert(performance.now() < deadline,
      `The long chat reaches the conversation projection: expected ${position}, saved ${checkpoint}`);
    await delay(100);
  }
}
