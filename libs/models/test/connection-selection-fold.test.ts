import { createHash } from 'node:crypto';
import type { StoredEvent } from '@opencrane/event-store';
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
}
it('never restores an older choice when duplicate rows follow a clear', replayAfterClear);
