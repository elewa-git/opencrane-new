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
  desktopInventory: z.union([z.array(z.never()).max(0), z.literal('unavailable')]),
  quietProof: z.enum(['unavailable', 'complete']), controlEnabled: z.literal(false) }).strict();
export type StopInput = { computerId: string; generation: number; podUid: string;
  takeoverId: string; affectedTurnIds: string[] };
export type StopExecution = (input: StopInput) => Promise<unknown>;
type Control = Exclude<ComputerControl, { phase: 'unverified' }>;

function controlBinding(control: Control) {
  const affectedTurnIds = [...control.affectedTurnIds];
  affectedTurnIds.sort();
  return { assistantId: control.assistantId, computerId: control.computerId,
    generation: control.generation, podUid: control.podUid,
    takeoverId: control.takeoverId, affectedTurnIds };
}
function checkedReceipt(control: Control, report: unknown) {
  const binding = controlBinding(control);
  const parsed = stopReceipt.safeParse(report);
  if (!parsed.success) throw new Error('Stop unavailable');
  const receipt = parsed.data;
  for (const key of ['generation', 'podUid', 'takeoverId', 'affectedTurnIds'] as const) {
    if (!isDeepStrictEqual(receipt[key], binding[key])) throw new Error('Stop unavailable');
  }
  return receipt;
}

export async function savePausing(store: EventStore, silo: string, control: Control,
  position: number, bridgeEpoch: string, report: unknown) {
  if (control.phase !== 'requested') return;
  const receipt = checkedReceipt(control, report);
  const data = { ...controlBinding(control), bridgeEpoch, supervisorEpoch: receipt.epoch,
    executionProof: 'exited', quietProof: 'unavailable' };
  await appendControl(store, silo, control, position, 'pausing', data);
}

export async function savePaused(store: EventStore, silo: string, control: Control,
  position: number, bridgeEpoch: string, report: unknown) {
  const receipt = checkedReceipt(control, report);
  if (control.phase !== 'pausing' || receipt.epoch !== control.supervisorEpoch
    || receipt.quietProof !== 'complete' || !Array.isArray(receipt.desktopInventory)) {
    throw new Error('Stop unavailable');
  }
  const data = { ...controlBinding(control), bridgeEpoch, supervisorEpoch: receipt.epoch,
    quietProof: 'complete' };
  await appendControl(store, silo, control, position, 'paused', data);
}

export async function saveFailed(store: EventStore, silo: string, control: Control,
  position: number) {
  if (control.phase !== 'requested' && control.phase !== 'pausing') {
    throw new Error('Stop unavailable');
  }
  const data = { ...controlBinding(control), reason: 'pause_timeout' };
  await appendControl(store, silo, control, position, 'failed', data);
}

async function appendControl(store: EventStore, silo: string, control: Control,
  position: number, phase: 'pausing' | 'paused' | 'failed', data: unknown) {
  const subject = `computer-${control.assistantId}`;
  const event = envelope(silo, subject, `takeover.${phase}`, data);
  const hash = createHash('sha256');
  hash.update(JSON.stringify([silo, subject, control.takeoverId, phase]));
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
