import { expect, it } from 'vitest';
import { privateOutputClearedSchema, privateReplySchema, serverMessageSchema } from '../src/index.ts';

const frame = { version: 1, topic: 'conversation', type: 'private_output_cleared',
  conversationId: 'chat', turnId: 'turn', threadId: 'thread', generation: 1,
  inputGeneration: 'input' };
function strictIdentity() {
  expect(privateOutputClearedSchema.parse(frame)).toEqual(frame);
  const extraFields = ['data', 'text', 'position', 'requesterId', 'token'];
  for (const name of extraFields) {
    const extra = { ...frame, [name]: 'refused' };
    expect(privateOutputClearedSchema.safeParse(extra).success).toBe(false);
  }
  for (const name of ['conversationId', 'turnId', 'threadId', 'inputGeneration']) {
    const missing = { ...frame, [name]: undefined };
    expect(privateOutputClearedSchema.safeParse(missing).success).toBe(false);
  }
  const invalidGeneration = { ...frame, generation: 0 };
  expect(privateOutputClearedSchema.safeParse(invalidGeneration).success).toBe(false);
  const reply = { ...frame, type: 'private_reply', data: { text: 'fixture', turnId: 'turn' } };
  expect(privateReplySchema.safeParse(reply).success).toBe(true);
  expect(serverMessageSchema.safeParse(reply).success).toBe(true);
  expect(serverMessageSchema.safeParse(frame).success).toBe(true);
}
it('accepts only the complete payload-free clearance identity and admits live frames on the socket',
  strictIdentity);
