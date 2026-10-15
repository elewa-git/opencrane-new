import { z } from 'zod';
import type { WebSocket } from 'ws';
import { computerSummary, readComputerControl, type ComputerControl, type tokenIssuer }
  from '@opencrane/auth';
import { readStreamSummary, type EventStore } from '@opencrane/event-store';
import { createLogger } from '@opencrane/observability';
import { requireTurnMember } from './turns.ts';

const identifier = z.string().regex(/^[\w-]{1,200}$/u);
const bindingData = z.object({ takeoverId: identifier, generation: z.int().positive(),
  affectedTurnIds: z.array(identifier).max(64) });
const receiptFields = bindingData.extend({ epoch: identifier });
const unavailableData = receiptFields.extend({ type: z.literal('bridge_unavailable') }).strict();
const quietData = receiptFields.extend({ type: z.literal('bridge_quiet'),
  interruptedTurnIds: z.array(identifier).max(64), preparingTurnIds: z.array(identifier).max(0),
  runningTurnIds: z.array(identifier).max(0), loadedThreadIds: z.array(identifier).max(0),
  heldApprovalIds: z.array(identifier).max(0), executorProof: z.literal('unavailable'),
  browserProof: z.literal('unavailable') }).strict();
const receiptData = z.discriminatedUnion('type', [unavailableData, quietData]);
const readyData = z.object({ computerId: z.string(), assistantId: z.string(),
  generation: z.int().positive(), podUid: z.string() });
type Tokens = Awaited<ReturnType<typeof tokenIssuer>>;
type Options = { store: EventStore; silo: string };
type Computer = { computerId: string; assistantId: string };
const logger = createLogger('bridge');

function computerFacts(summary: ReturnType<typeof computerSummary.empty>) {
  return { lifecycle: summary.lifecycle, grant: summary.grant, claim: summary.claim };
}
async function facts(options: Options, computer: Computer) {
  return readStreamSummary(options.store, options.silo, `computer-${computer.assistantId}`,
    computerSummary, performance.now() + 10_000, computerFacts);
}

// Issue a connection pass without waking a computer that became suspended during polling.
export async function readyBridgePass(options: Options, computer: Computer, tokens: Tokens) {
  const saved = await facts(options, computer);
  if (saved.lifecycle?.event.type !== 'computer.ready') throw new Error('Computer is not ready');
  const identity = readyData.omit({ podUid: true });
  // Keep older ready records usable for reports; gate delivery requires the full identity.
  const connectionData = identity.partial({ generation: true });
  const ready = connectionData.parse(saved.lifecycle.event.data);
  const claim = identity.parse(saved.claim?.event.data);
  const grantData = connectionData.extend({ tokenId: z.string() });
  const grant = grantData.parse(saved.grant?.event.data);
  if (ready.computerId !== computer.computerId || ready.assistantId !== computer.assistantId) {
    throw new Error('Computer identity changed');
  }
  const generation = ready.generation ?? claim.generation;
  for (const current of [claim, grant]) {
    if (current.computerId !== ready.computerId || current.assistantId !== ready.assistantId
      || (current.generation ?? claim.generation) !== generation) {
      throw new Error('Computer identity changed');
    }
  }
  const details = { ...computer, silo: options.silo,
    generation: claim.generation, tokenId: grant.tokenId };
  return tokens.computer(details);
}

function requireReadyControl(control: Extract<ComputerControl, { phase: 'requested' }>,
  saved: Awaited<ReturnType<typeof facts>>, computer: Computer) {
  const ready = readyData.parse(saved.lifecycle?.event.data);
  if (saved.lifecycle?.event.type !== 'computer.ready'
    || ready.computerId !== computer.computerId || control.computerId !== computer.computerId
    || ready.assistantId !== computer.assistantId || control.assistantId !== computer.assistantId
    || ready.generation !== control.generation || ready.podUid !== control.podUid) {
    throw new Error('Computer identity changed');
  }
  const affectedTurnIds = [...control.affectedTurnIds];
  affectedTurnIds.sort();
  const details = { takeoverId: control.takeoverId, generation: control.generation, affectedTurnIds };
  const binding = bindingData.parse(details);
  if (new Set(affectedTurnIds).size !== affectedTurnIds.length) {
    throw new Error('Invalid affected turns');
  }
  return binding;
}

function matchesReceipt(next: z.infer<typeof receiptData>, sent: z.infer<typeof bindingData>,
  previous: z.infer<typeof receiptData> | undefined) {
  if (next.takeoverId !== sent.takeoverId || next.generation !== sent.generation
    || JSON.stringify(next.affectedTurnIds) !== JSON.stringify(sent.affectedTurnIds)
    || (previous && next.epoch !== previous.epoch)) return false;
  if (next.type === 'bridge_quiet') {
    for (const turnId of next.interruptedTurnIds) {
      if (!sent.affectedTurnIds.includes(turnId)) return false;
    }
  }
  return true;
}

export function bridgeControl(options: Options, computer: Computer, tokens: Tokens | undefined,
  socket: WebSocket, refuse: (reason: string) => void) {
  let sent: z.infer<typeof bindingData> | undefined;
  let receipt: z.infer<typeof receiptData> | undefined;
  let logged = false;
  let rejected = false;

  function unavailable() {
    if (logged) return;
    logged = true;
    logger.warn('Bridge gate unavailable');
  }
  async function send() {
    if (sent || rejected || socket.readyState !== socket.OPEN) return;
    try {
      const subject = `computer-${computer.assistantId}`;
      const position = await options.store.head(subject);
      const control = await readComputerControl(options.store, options.silo, computer.assistantId);
      if (control?.phase !== 'requested') return;
      const saved = await facts(options, computer);
      if (!tokens) throw new Error('Bridge issuer unavailable');
      const binding = requireReadyControl(control, saved, computer);
      const fresh = await requireTurnMember(options.store, options.silo, control.requesterId);
      const claims = { silo: options.silo, computer: computer.computerId,
        assistant: computer.assistantId, podUid: control.podUid, ...binding };
      const issued = await tokens.takeoverGate(claims);
      if (await options.store.head(subject, fresh.deadline) !== position) {
        unavailable();
        return;
      }
      await fresh();
      if (sent || rejected || socket.readyState !== socket.OPEN) return;
      sent = binding;
      const frame = { type: 'bridge_gate', gate: issued.value };
      socket.send(JSON.stringify(frame));
    } catch {
      // Keep signing and validation errors from exposing the gate or saved request.
      unavailable();
    }
  }
  function receive(value: unknown) {
    if (typeof value !== 'object' || value === null) return false;
    const type: unknown = Reflect.get(value, 'type');
    if (type !== 'bridge_quiet' && type !== 'bridge_unavailable') return false;
    const parsed = receiptData.safeParse(value);
    if (!parsed.success || !sent || rejected || socket.readyState !== socket.OPEN
      || !matchesReceipt(parsed.data, sent, receipt)) {
      receipt = undefined;
      rejected = true;
      refuse('Invalid bridge receipt');
    } else {
      receipt = parsed.data;
    }
    return true;
  }
  return { send, receive, get receipt() { return receipt; } };
}
