import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ComputerControl } from '@opencrane/auth';
import { readEventAt, type EventStore } from '@opencrane/event-store';
import { envelope } from '@opencrane/models';

const identifier = z.string().regex(/^[\w-]{1,200}$/u);
const stopReceipt = z.object({ kind: z.literal('executor_stop'),
  generation: z.int().positive(), podUid: identifier, takeoverId: identifier,
  affectedTurnIds: z.array(identifier).max(64), epoch: identifier,
  executionQuiet: z.literal(true), executionInventory: z.array(z.never()).max(0),
  quietProof: z.literal('unavailable'), controlEnabled: z.literal(false) }).strict();
export type StopInput = { computerId: string; generation: number; podUid: string;
  takeoverId: string; affectedTurnIds: string[] };
export type StopExecution = (input: StopInput) => Promise<unknown>;

export async function savePausing(store: EventStore, silo: string,
  control: Exclude<ComputerControl, { phase: 'unverified' }>, position: number,
  bridgeEpoch: string, report: unknown) {
  if (control.phase === 'pausing') return;
  const affectedTurnIds = [...control.affectedTurnIds];
  affectedTurnIds.sort();
  const binding = { generation: control.generation, podUid: control.podUid,
    takeoverId: control.takeoverId, affectedTurnIds };
  const receipt = stopReceipt.parse(report);
  for (const key of ['generation', 'podUid', 'takeoverId', 'affectedTurnIds'] as const) {
    if (!isDeepStrictEqual(receipt[key], binding[key])) throw new Error('Stop unavailable');
  }
  const data = { assistantId: control.assistantId, computerId: control.computerId,
    ...binding, bridgeEpoch, supervisorEpoch: receipt.epoch,
    executionProof: 'exited', quietProof: 'unavailable' };
  const subject = `computer-${control.assistantId}`;
  const event = envelope(silo, subject, 'takeover.pausing', data);
  const hash = createHash('sha256');
  hash.update(JSON.stringify([silo, subject, control.takeoverId, 'pausing']));
  event.id = hash.digest('hex');
  event.commandId = event.id;
  event.source = 'opencrane-server';
  event.principal = { kind: 'system', id: 'opencrane-server' };
  const command = { event, expectedSequence: position, historyChecked: true as const };
  const result = await store.append(command);
  if (result.status !== 'appended') throw new Error('Stop unavailable');
  const saved = await readEventAt(store, subject, result.sequence, performance.now() + 10_000);
  if (!isDeepStrictEqual(saved?.event.data, data)) throw new Error('Stop unavailable');
}
