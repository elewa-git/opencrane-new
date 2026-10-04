import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EventEnvelope } from '@opencrane/events';
import { computerWorkPaused } from '@opencrane/events';
import { envelope, history } from '@opencrane/models';
import type { memberAuthorisation } from '@opencrane/authz';
import type { ChatOptions } from './routes.ts';
import { turnCommand } from './turns.ts';

/** Explicit release requests a fresh checked turn; it never repeats the interrupted request. */
export async function resumeAfterRelease(options: Pick<ChatOptions, 'silo' | 'store' | 'keys'>, end: EventEnvelope, auth: ReturnType<typeof memberAuthorisation>) {
  const data = z.object({ assistantId: z.string(), computerId: z.string(), reason: z.literal('released'), leaseId: z.string(),
    affectedTurns: z.array(z.object({ conversationId: z.string(), turnId: z.string(), requesterId: z.string() })) }).parse(end.data);
  for (const turn of data.affectedTurns) {
    // Confirmed local quiescence closes missing reports without asserting an external outcome.
    await turnCommand(options.store, { silo: options.silo, assistantId: data.assistantId, computerId: data.computerId },
      { ...turn, status: 'failed' });
    const id = createHash('sha256').update(`${data.leaseId}:${turn.turnId}:release`).digest('hex');
    const rows = await history(options.store, `conversation-${turn.conversationId}`, options.silo);
    if (rows.some(r => r.event.id === id || r.event.type === 'conversation.closed') || rows.findLast(r => r.event.type === 'message.posted')?.event.id !== turn.turnId) continue;
    if (!(await auth.conversation(turn.requesterId, turn.conversationId, 'post')).allowed) continue;
    const lifecycle = await history(options.store, `computer-${data.assistantId}`, options.silo);
    if (computerWorkPaused(lifecycle.map(r => r.event))) return;
    const event = envelope(options.silo, `conversation-${turn.conversationId}`, 'message.posted', {
      conversationId: turn.conversationId, authorId: turn.requesterId, authorKind: 'system', contentType: 'text',
      ...options.keys.encrypt(options.silo, turn.conversationId,
        'The person explicitly returned computer control. Inspect the current desktop and task state before continuing. Do not resubmit pending approvals or retry an external action already dispatched; keep unknown outcomes uncertain.'),
    });
    event.id = id; event.commandId = id; event.source = 'opencrane-server'; event.principal = { kind: 'system', id: 'takeover-release' };
    event.correlation = { conversation: turn.conversationId, turn: id };
    if ((await options.store.append({ event, expectedSequence: rows.at(-1)?.sequence ?? 0 })).status !== 'appended') throw new Error('Release continuation unavailable');
  }
}
