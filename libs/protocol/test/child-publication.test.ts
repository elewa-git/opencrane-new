import { expect, it } from 'vitest';
import { chatRowSchema } from '../src/chat.ts';

function acceptsPublication(publicationKind: string) {
  const data = { text: 'Reviewed update', authorId: 'alice', publicationKind, contentType: 'text' };
  const row = { id: 'publication', position: 20, type: 'conversation.child_result_published',
    time: '2026-10-16T00:00:00.000Z', data };
  expect(chatRowSchema.parse(row).data).toEqual(data);
}
it.each(['final', 'interim'])('reads a credited %s parent entry', acceptsPublication);
