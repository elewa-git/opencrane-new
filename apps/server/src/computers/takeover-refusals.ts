import type { z } from 'zod';
import { takeoverRefusedDataSchema, type EventEnvelope } from '@opencrane/events';
import { envelope } from '@opencrane/models';
import { ChatRefused, type ChatOptions, type writeChatAccess } from '../chat/access.ts';
import { refusalDigest } from '../members/refusals.ts';

export class RequesterOnly extends ChatRefused {}
export class ControlConflict extends Error {}
type Refusal = z.infer<typeof takeoverRefusedDataSchema>;
type Attempt = { commandId: string; conversationId: string;
  requesterEventId: string; generation: number };

function refusalBinding(silo: string, actorId: string, input: Attempt) {
  const fields = [silo, actorId, input.commandId, input.conversationId,
    input.requesterEventId, input.generation];
  return { attemptId: input.commandId, actorId, inputDigest: refusalDigest(fields) };
}

export function throwControlRefusal(reason: Refusal['reason']): never {
  if (reason === 'requester_only') throw new RequesterOnly('Requester only');
  throw new ControlConflict('Control conflict');
}

function refusalData(event: EventEnvelope, silo: string, attemptId: string) {
  const parsed = takeoverRefusedDataSchema.safeParse(event.data);
  if (event.type !== 'takeover.refused' || event.silo !== silo ||
      event.subject !== `view-${attemptId}` || event.source !== 'opencrane-server' ||
      !parsed.success || event.principal?.kind !== 'human' ||
      event.principal.id !== parsed.data.actorId || parsed.data.attemptId !== attemptId) {
    throw new Error('Control audit unavailable');
  }
  return parsed.data;
}

export async function savedControlRefusal(options: ChatOptions, actorId: string,
  input: Attempt, deadline = performance.now() + 2_000) {
  const subject = `view-${input.commandId}`;
  const expected = refusalBinding(options.silo, actorId, input);
  let saved: Refusal | undefined;
  try {
    for await (const row of options.store.readStream(subject, 1, deadline)) {
      if (saved) throw new Error('Control audit unavailable');
      saved = refusalData(row.event, options.silo, input.commandId);
    }
  } catch {
    // Keep storage errors and rejected event data out of replies and logs.
    throw new Error('Control audit unavailable');
  }
  if (saved && (saved.actorId !== expected.actorId || saved.inputDigest !== expected.inputDigest)) {
    throw new ControlConflict('Control conflict');
  }
  return saved?.reason;
}

export async function recordControlRefusal(options: ChatOptions, actorId: string,
  input: Attempt, reason: Refusal['reason'],
  fresh: Awaited<ReturnType<typeof writeChatAccess>>) {
  const binding = refusalBinding(options.silo, actorId, input);
  const attempted = { ...binding, reason };
  const parsed = takeoverRefusedDataSchema.safeParse(attempted);
  if (!parsed.success) throw new Error('Control audit unavailable');
  const subject = `view-${input.commandId}`;
  const event = envelope(options.silo, subject, 'takeover.refused', parsed.data);
  event.id = refusalDigest([options.silo, subject, 'takeover.refused']);
  event.commandId = event.id;
  event.source = 'opencrane-server';
  event.principal = { kind: 'human', id: actorId };
  await fresh();
  const deadline = fresh.deadline;
  const command = { event, expectedSequence: 0, historyChecked: true as const,
    deadline, checkAccess: fresh };
  try {
    await options.store.append(command);
  } catch {
    // Read back even a lost reply: the append may already have committed.
  }
  const saved = await savedControlRefusal(options, actorId, input, deadline);
  if (!saved) throw new Error('Control audit unavailable');
  return throwControlRefusal(saved);
}
