import { expect, it } from 'vitest';
import { childResultPublishedDataSchema } from '../src/index.ts';

const common = { conversationId: 'parent', publishedBy: 'alice', childConversationId: 'child',
  reviewDigest: 'a'.repeat(64), ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1',
  contentType: 'text' };
const source = { resultEventId: 'saved-result', resultPosition: 20, turnId: 'saved-turn' };

function acceptsPublication(publicationKind: string) {
  const data = { ...common, ...source, publicationKind };
  expect(childResultPublishedDataSchema.safeParse(data).success).toBe(true);
}
it.each(['final', 'interim'])('accepts a sourced %s publication', acceptsPublication);

function acceptsHumanInterim() {
  const data = { ...common, publicationKind: 'interim' };
  expect(childResultPublishedDataSchema.safeParse(data).success).toBe(true);
}
it('accepts a human interim update without result references', acceptsHumanInterim);

function refusesPartialSource(publicationKind: string) {
  for (const field of Object.keys(source)) {
    const data: Record<string, unknown> = { ...common, ...source, publicationKind };
    delete data[field];
    expect(childResultPublishedDataSchema.safeParse(data).success).toBe(false);
  }
  const data = { ...common, publicationKind, resultEventId: 'saved-result' };
  expect(childResultPublishedDataSchema.safeParse(data).success).toBe(false);
}
it.each(['final', 'interim'])('refuses partial %s result references', refusesPartialSource);

function refusesFinalWithoutSource() {
  const data = { ...common, publicationKind: 'final' };
  expect(childResultPublishedDataSchema.safeParse(data).success).toBe(false);
}
it('still requires a final result reference', refusesFinalWithoutSource);
