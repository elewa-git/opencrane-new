import { createHash } from 'node:crypto';
import type { StoredEvent } from '@opencrane/event-store';
import { connectionSelectedDataSchema } from '@opencrane/events';
import { expect, it } from 'vitest';
import { envelope } from '../src/actor.ts';
import { foldConnectionSelection } from '../src/connection-selection.ts';

function selectionRow(sequence: number, expectedSequence: number, action = 'select'): StoredEvent {
  const subject = 'connection-selection-person-server';
  const commandId = `change-${sequence}`;
  const hash = createHash('sha256');
  hash.update(JSON.stringify(['test', subject, commandId]));
  const fields = { action, userId: 'person', serverId: 'server',
    connectionId: 'installed', expectedSequence };
  let data: unknown = fields;
  if (action === 'select') {
    data = { ...fields, profileId: 'personal', profileRevision: 1 };
  }
  const event = envelope('test', subject, 'connection.selected', data, hash.digest('hex'));
  event.commandId = commandId;
  event.source = 'opencrane-server';
  event.principal = { kind: 'human', id: 'person' };
  return { sequence, event };
}

function replayAfterClear() {
  const first = selectionRow(10, 0);
  const second = selectionRow(20, 10);
  const clear = selectionRow(30, 20, 'clear');
  expect(foldConnectionSelection([first, second]).selected).toEqual(second.event.data);
  const rows = [first, second, clear, first, second];
  expect(foldConnectionSelection(rows)).toEqual({ sequence: 30, selected: null });
  const fresh = selectionRow(40, 30);
  expect(foldConnectionSelection([...rows, fresh])).toEqual({
    sequence: 40, selected: fresh.event.data,
  });
}
it('never restores an older choice when duplicate rows follow a clear', replayAfterClear);

function updateDigest(row: StoredEvent) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([row.event.silo, row.event.subject, row.event.commandId]));
  row.event.id = hash.digest('hex');
}

function invalidRow(field: string) {
  const first = selectionRow(10, 0);
  const second = selectionRow(20, 10);
  expect(foldConnectionSelection([first, second]).selected).toEqual(second.event.data);
  const selected = connectionSelectedDataSchema.parse(second.event.data);
  if (field === 'schema') {
    second.event.data = { ...selected, profileRevision: 0 };
  } else if (field === 'type') {
    second.event.type = 'connection.created';
  } else if (field === 'source') {
    second.event.source = 'untrusted';
  } else if (field === 'principal kind') {
    second.event.principal = { kind: 'system', id: 'person' };
  } else if (field === 'principal id') {
    second.event.principal = { kind: 'human', id: 'another-person' };
  } else if (field === 'digest') {
    second.event.id = '0'.repeat(64);
  } else if (field === 'silo') {
    second.event.silo = 'another-silo';
    updateDigest(second);
  } else if (field === 'subject identity') {
    second.event.subject = 'connection-selection-person-another-server';
    updateDigest(second);
  } else if (field === 'subject continuity') {
    second.event.subject = 'connection-selection-person-another-server';
    second.event.data = { ...selected, serverId: 'another-server' };
    updateDigest(second);
  } else if (field === 'expected position') {
    second.event.data = { ...selected, expectedSequence: 0 };
  } else if (field === 'order') {
    second.sequence = 10;
  }
  const state = foldConnectionSelection([first, second]);
  expect(state.selected).toBeNull();
  let expectedPosition = 20;
  if (field === 'order') {
    expectedPosition = 10;
  }
  expect(state.sequence).toBe(expectedPosition);
}
it.each(['schema', 'type', 'source', 'principal kind', 'principal id', 'digest', 'silo',
  'subject identity', 'subject continuity', 'expected position', 'order'])(
  'leaves no usable choice after a row with an invalid %s', invalidRow);
