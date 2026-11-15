import { createHash } from 'node:crypto';
import type { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '../../src/actor.ts';

export async function seedKeyAssistant(nats: Awaited<ReturnType<typeof natsFixture>>,
  userId: string, assistantId = userId, kind: 'personal' | 'team' = 'personal') {
  await nats.seed([envelope('test', `assistant-${assistantId}`, 'assistant.created', {
    assistantId, ownerId: userId, kind,
  })]);
}

export function releaseDigest(value: unknown) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(value));
  return hash.digest('hex');
}
