import { describe, expect, it } from 'vitest';
import {
  approvalDecidedDataSchema,
  effectObservedDataSchema,
  eventRegistry,
  getEventDefinition,
  listEventTypes,
  memberJoinedDataSchema,
  messagePostedDataSchema,
} from '../src/index.ts';

describe('eventRegistry', () => {
  it('has no duplicate event types', () => {
    const types = listEventTypes();
    expect(new Set(types).size).toBe(types.length);
  });

  it('gives every entry a non-empty stream and description', () => {
    for (const entry of eventRegistry) {
      expect(entry.stream.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('finds a known event by type', () => {
    expect(getEventDefinition('member.joined')?.stream).toBe('member');
    expect(getEventDefinition('no.such.event')).toBeUndefined();
  });

  it('uses the four example schemas for their events, and z.unknown() elsewhere', () => {
    expect(getEventDefinition('member.joined')?.dataSchema).toBe(memberJoinedDataSchema);
    expect(getEventDefinition('message.posted')?.dataSchema).toBe(messagePostedDataSchema);
    expect(getEventDefinition('approval.decided')?.dataSchema).toBe(approvalDecidedDataSchema);
    expect(getEventDefinition('effect.observed')?.dataSchema).toBe(effectObservedDataSchema);

    // A handful of events that are still placeholders: any data passes.
    for (const type of ['org.created', 'budget.exhausted', 'security.alert_raised']) {
      const schema = getEventDefinition(type)?.dataSchema;
      expect(schema?.safeParse({ anything: 'goes' }).success).toBe(true);
    }
  });

  it('carries at least one entry for every stream named in the catalogue', () => {
    const expectedStreams = [
      'org',
      'member',
      'team',
      'assistant',
      'computer',
      'conversation',
      'approval',
      'effect',
      'mcp',
      'connection',
      'grant',
      'budget',
      'scope',
      'routine',
      'delegation',
      'security',
    ];
    const actualStreams = new Set(eventRegistry.map((entry) => entry.stream));
    for (const stream of expectedStreams) {
      expect(actualStreams.has(stream)).toBe(true);
    }
  });
});
