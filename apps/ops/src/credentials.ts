import type { IncomingHttpHeaders } from 'node:http';
import { computerTokenAudience, turnTokenAudience, type tokenIssuer } from '@opencrane/auth';
import type { EventStore } from '@opencrane/event-store';
import { field, history } from './lifecycle.ts';

type Tokens = Awaited<ReturnType<typeof tokenIssuer>>;
/** P2-4's ext_authz credential check. Authorisation still owns live turn/requester permissions. */
export function computerCredentials(store: Pick<EventStore, 'readStream'>, tokens: Tokens, silo: string) {
  async function active(assistantId: string) {
    const events = await history(store, `computer-${assistantId}`);
    const latest = events.at(-1)?.event;
    if (!latest || latest.silo !== silo || !['computer.ready', 'computer.resumed'].includes(latest.type)) {
      throw new Error('Computer is not active');
    }
    const grant = events.findLast(({ event }) => ['computer.claimed', 'computer.resumed'].includes(event.type))!.event;
    return { id: field(grant.data, 'tokenId'), computerId: field(grant.data, 'computerId') };
  }
  return {
    async turn(input: { assistantId: string; conversationId: string; turnId: string; requesterId: string }) {
      const computer = await active(input.assistantId);
      return tokens.turn({ ...input, silo, computerTokenId: computer.id });
    },
    async check(headers: IncomingHttpHeaders, activeTurnId: string) {
      const bearer = headers.authorization;
      const turnValue = headers['x-turn-token'];
      if (!bearer?.startsWith('Bearer ') || typeof turnValue !== 'string') throw new Error('Missing credentials');
      const computer = await tokens.verify(bearer.slice(7), computerTokenAudience);
      const turn = await tokens.verify(turnValue, turnTokenAudience, activeTurnId);
      if (typeof computer['assistant'] !== 'string') throw new Error('Missing assistant');
      const current = await active(computer['assistant']);
      if (computer['typ'] !== 'computer' || turn['typ'] !== 'turn' || computer['silo'] !== silo || turn['silo'] !== silo ||
          computer.jti !== current.id || computer['computer'] !== current.computerId || turn['computerTokenId'] !== current.id ||
          turn['assistant'] !== computer['assistant'] || turn['conversation'] !== headers['session-id']) throw new Error('Credential binding mismatch');
      return { computer, turn };
    },
  };
}
