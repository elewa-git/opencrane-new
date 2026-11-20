import { expect, it } from 'vitest';
import { z } from 'zod';
import { getEventDefinition } from '../src/registry.ts';

function plaintextConversation(type: string) {
  const definition = getEventDefinition(type)!;
  const example = z.record(z.string(), z.unknown()).parse(definition.example);
  const { ciphertext: _ciphertext, keyId: _keyId, ...identity } = example;
  const data = { ...identity, utterance: 'A restored conversation is readable.' };
  expect(definition.dataSchema.safeParse(data).success).toBe(true);
  expect(definition.dataSchema.safeParse({ ...data, ciphertext: 'old encrypted data' }).success)
    .toBe(false);
  expect(definition.dataSchema.safeParse({ ...data, utterance: 'x'.repeat(1_048_577) }).success)
    .toBe(false);
}

it.each([
  'message.posted', 'agent.message_delta', 'agent.message_completed',
  'agent.reasoning_summarised', 'conversation.child_result_published',
])('%s stores bounded, explicitly named conversation prose', plaintextConversation);

function refusesStorageUnsafeProse(type: string) {
  const definition = getEventDefinition(type)!;
  const example = z.record(z.string(), z.unknown()).parse(definition.example);
  for (const character of ['\u0000', '\ud800', '\udfff']) {
    const text = `private-text${character}after`;
    let data: unknown = { ...example, utterance: text };
    if (type === 'agent.command_ran') data = { ...example, view: { preview: text } };
    if (type === 'tool.approval_requested') data = { ...example, review: text };
    if (type === 'routine.created') {
      const shape = z.object({ definition: z.record(z.string(), z.unknown()) }).parse(example);
      data = { ...example, definition: { ...shape.definition, instructions: text } };
    }
    expect(definition.dataSchema.safeParse(data).success).toBe(false);
  }
}
it.each([
  'message.posted', 'agent.message_delta', 'agent.message_completed',
  'agent.reasoning_summarised', 'conversation.child_result_published',
  'agent.command_ran', 'tool.approval_requested', 'routine.created',
])('%s refuses text PostgreSQL JSONB cannot store', refusesStorageUnsafeProse);
