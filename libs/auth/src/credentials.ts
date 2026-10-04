import type { IncomingHttpHeaders } from 'node:http';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { z } from 'zod';
import { computerTokenAudience, turnTokenAudience, type tokenIssuer, type tokenVerifier } from './tokens.ts';

type Verifier = ReturnType<typeof tokenVerifier> & Partial<Pick<Awaited<ReturnType<typeof tokenIssuer>>, 'turn'>>;
const state = z.object({ assistantId: z.string(), computerId: z.string(), generation: z.int().positive() });
const grant = state.extend({ generation: z.int().positive().optional(), tokenId: z.string().min(1) });

/** Current event-backed computer grant; shared by lifecycle issuance and model admission. */
export function computerCredentials(store: Pick<EventStore, 'readStream'>, tokens: Verifier, silo: string) {
  async function active(assistantId: string, deadline = Infinity) {
    const events: StoredEvent[] = [];
    for await (const item of store.readStream(`computer-${assistantId}`, 1, deadline)) {
      if (item.event.silo !== silo) throw new Error('Computer silo mismatch');
      events.push(item);
    }
    const latest = events.findLast(r => !r.event.type.startsWith('computer.turn_'));
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
    return { ...current, sequence: latest.sequence };
  }
  function checkBinding(computer: Awaited<ReturnType<Verifier['verify']>>,
    turn: Awaited<ReturnType<Verifier['verify']>>, current: Awaited<ReturnType<typeof active>>,
    sessionId: IncomingHttpHeaders['session-id']) {
    if (computer['typ'] !== 'computer' || turn['typ'] !== 'turn' ||
        computer['silo'] !== silo || turn['silo'] !== silo ||
        computer.jti !== current.tokenId || computer['computer'] !== current.computerId ||
        computer['generation'] !== current.generation || turn['computerTokenId'] !== current.tokenId ||
        turn['assistant'] !== computer['assistant'] ||
        z.string().min(1).parse(turn['thread']) !== sessionId) {
      throw new Error('Credential binding mismatch');
    }
  }
  return {
    async turn(input: { assistantId: string; conversationId: string; turnId: string; requesterId: string; threadId: string; task: string; model: string }) {
      const computer = await active(input.assistantId);
      if (!tokens.turn) throw new Error('Turn issuer unavailable');
      return tokens.turn({ ...input, silo, computerTokenId: computer.tokenId });
    },
    async check(headers: IncomingHttpHeaders, activeTurnId?: string, deadline = Infinity) {
      const bearer = headers.authorization, turnValue = headers['x-turn-token'];
      if (!bearer?.startsWith('Bearer ') || typeof turnValue !== 'string') throw new Error('Missing credentials');
      const computer = await tokens.verify(bearer.slice(7), computerTokenAudience);
      const turn = await tokens.verify(turnValue, turnTokenAudience, activeTurnId);
      if (typeof computer['assistant'] !== 'string') throw new Error('Missing assistant');
      const current = await active(computer['assistant'], deadline);
      checkBinding(computer, turn, current, headers['session-id']);
      return { computer, turn, sequence: current.sequence };
    },
  };
}
