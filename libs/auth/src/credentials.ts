import type { IncomingHttpHeaders } from 'node:http';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { z } from 'zod';
import { computerWorkPaused } from '@opencrane/events';
import { computerTokenAudience, turnTokenAudience, type tokenIssuer, type tokenVerifier } from './tokens.ts';

type Verifier = ReturnType<typeof tokenVerifier> & Partial<Pick<Awaited<ReturnType<typeof tokenIssuer>>, 'turn'>>;
const state = z.object({ assistantId: z.string(), computerId: z.string(), generation: z.int().positive() });
const grant = state.extend({ generation: z.int().positive().optional(), tokenId: z.string().min(1) });

/** Current event-backed computer grant; shared by lifecycle issuance and model admission. */
export function computerCredentials(store: Pick<EventStore, 'readStream'>, tokens: Verifier, silo: string) {
  async function active(assistantId: string) {
    const events: StoredEvent[] = [];
    for await (const item of store.readStream(`computer-${assistantId}`)) {
      if (item.event.silo !== silo) throw new Error('Computer silo mismatch');
      events.push(item);
    }
    if (computerWorkPaused(events.map(r => r.event))) throw new Error('Computer paused');
    const latest = events.findLast(r => !r.event.type.startsWith('computer.turn_') && !r.event.type.startsWith('takeover.'));
    if (latest?.event.type !== 'computer.ready') throw new Error('Computer is not ready');
    const claim = state.parse(events.findLast(({ event }) => event.type === 'computer.claimed')?.event.data);
    const recorded = grant.parse(events.findLast(({ event }) => ['computer.claimed', 'computer.resumed'].includes(event.type))?.event.data);
    // Older resume grants inherit their claim's generation; Ready must still state it explicitly.
    const current = { ...recorded, generation: recorded.generation ?? claim.generation };
    const ready = state.parse(latest.event.data);
    for (const value of [claim, current, ready]) {
      if (value.assistantId !== assistantId || value.computerId !== claim.computerId || value.generation !== claim.generation) {
        throw new Error('Computer generation mismatch');
      }
    }
    return { ...current, sequence: latest.sequence, events };
  }
  function checkTurnFence(events: StoredEvent[], turnId: unknown) {
    const fence = events.findLast(r => r.event.type === 'takeover.requested');
    const started = events.findLast(r => r.event.type === 'computer.turn_started' &&
      z.object({ turnId: z.string() }).parse(r.event.data).turnId === turnId);
    // A released fence never revives credentials belonging to an interrupted turn.
    if (fence && (!started || started.sequence <= fence.sequence)) throw new Error('Turn interrupted by takeover');
  }
  return {
    async turn(input: { assistantId: string; conversationId: string; turnId: string; requesterId: string; threadId: string; task: string; model: string }) {
      const computer = await active(input.assistantId);
      if (!tokens.turn) throw new Error('Turn issuer unavailable');
      return tokens.turn({ ...input, silo, computerTokenId: computer.tokenId });
    },
    async check(headers: IncomingHttpHeaders, activeTurnId?: string) {
      const bearer = headers.authorization, turnValue = headers['x-turn-token'];
      if (!bearer?.startsWith('Bearer ') || typeof turnValue !== 'string') throw new Error('Missing credentials');
      const computer = await tokens.verify(bearer.slice(7), computerTokenAudience);
      const turn = await tokens.verify(turnValue, turnTokenAudience, activeTurnId);
      if (typeof computer['assistant'] !== 'string') throw new Error('Missing assistant');
      const current = await active(computer['assistant']);
      checkTurnFence(current.events, turn['turn']);
      if (computer['typ'] !== 'computer' || turn['typ'] !== 'turn' || computer['silo'] !== silo || turn['silo'] !== silo ||
          computer.jti !== current.tokenId || computer['computer'] !== current.computerId || computer['generation'] !== current.generation ||
          turn['computerTokenId'] !== current.tokenId || turn['assistant'] !== computer['assistant'] ||
          z.string().min(1).parse(turn['thread']) !== headers['session-id']) throw new Error('Credential binding mismatch');
      return { computer, turn, sequence: current.sequence };
    },
  };
}
