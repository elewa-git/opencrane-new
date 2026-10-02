import { expect, it } from 'vitest';
import { modelForTask } from '../src/routing.ts';

it('uses Sol for a chat turn and Luna for conversation titles', () => {
  expect(modelForTask('chat_turn')).toBe('gpt-6.1-sol');
  expect(modelForTask('conversation_title')).toBe('gpt-6-luna');
});
it.each([
  ['ambiguous_problem', 'gpt-6-astra'], ['deep_analysis', 'gpt-6-astra'], ['ambitious_deliverable', 'gpt-6-astra'],
  ['scoped_task', 'gpt-6-luna'], ['triage', 'gpt-6-luna'], ['frequent_automation', 'gpt-6-luna'],
  ['classify_upload', 'gpt-6-luna'], ['summary', 'gpt-6-luna'],
] as const)('routes %s to %s', (task, expected) => {
  expect(modelForTask(task)).toBe(expected);
});
it('refuses unknown task kinds instead of inheriting an object property', () => {
  // Simulate input from an untyped caller at the public boundary.
  expect(() => modelForTask('toString')).toThrow('Unknown task kind');
});
