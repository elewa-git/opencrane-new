import { providerTurnBindingSchema } from '@opencrane/events';
import type { IncomingHttpHeaders } from 'node:http';
import { readStreamSummary, WrongSiloError, type EventStore } from '@opencrane/event-store';
import { computerSummary, type ComputerSummary } from './computer-summary.ts';
import { z } from 'zod';
import { computerTokenAudience, turnTokenAudience, type tokenIssuer, type tokenVerifier } from './tokens.ts';

type Verifier = ReturnType<typeof tokenVerifier> & Partial<Pick<Awaited<ReturnType<typeof tokenIssuer>>, 'turn'>>;
const recordedChoiceFields = providerTurnBindingSchema.extend({
  model: z.string().min(1), task: z.literal('chat_turn'),
});
const recordedChoiceSchema = recordedChoiceFields.strip();
const state = z.object({ assistantId: z.string(), computerId: z.string(), generation: z.int().positive() });
const grant = state.extend({ generation: z.int().positive().optional(), tokenId: z.string().min(1) });

/** Current event-backed computer grant; shared by lifecycle issuance and model admission. */
export function computerCredentials(store: Pick<EventStore, 'readStream'>, tokens: Verifier, silo: string) {
  async function active(assistantId: string, deadline = Infinity) {
    function take(summary: ComputerSummary) {
      return { control: summary.control, lifecycle: summary.lifecycle,
        claim: summary.claim, grant: summary.grant };
    }
    let facts: ReturnType<typeof take>;
    try {
      facts = await readStreamSummary(store, silo, `computer-${assistantId}`,
        computerSummary, deadline, take);
    } catch (error) {
      if (error instanceof WrongSiloError) {
        throw new Error('Computer silo mismatch', { cause: error });
      }
      throw error;
    }
    if (facts.control) throw new Error('Computer control is pending');
    const latest = facts.lifecycle;
    if (latest?.event.type !== 'computer.ready') throw new Error('Computer is not ready');
    const claim = state.parse(facts.claim?.event.data);
    const recorded = grant.parse(facts.grant?.event.data);
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
        computer['generation'] !== current.generation ||
        turn['computerTokenId'] !== current.tokenId ||
        turn['assistant'] !== computer['assistant'] ||
        z.string().min(1).parse(turn['thread']) !== sessionId) {
      throw new Error('Credential binding mismatch');
    }
  }
  return {
    async turn(input: {
      assistantId: string; conversationId: string; turnId: string; requesterId: string;
      threadId: string; task: string; model: string;
      contextClass?: 'shared_only' | undefined;
      providerId?: string | undefined; bindingSequence?: number | undefined;
    }) {
      if (input.task === 'native_descendant') throw new Error('Native delegation is disabled');
      const computer = await active(input.assistantId);
      if (!tokens.turn) throw new Error('Turn issuer unavailable');
      await checkRecordedProviderChoice(store, silo, input);
      const turn = { ...input, silo, computerTokenId: computer.tokenId };
      return tokens.turn(turn);
    },
    async check(
      headers: IncomingHttpHeaders, activeTurnId?: string, deadline = Infinity,
    ) {
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

async function checkRecordedProviderChoice(
  store: Pick<EventStore, 'readStream'>, silo: string, input: {
    assistantId: string; turnId: string; model: string; task: string;
    providerId?: string | undefined; bindingSequence?: number | undefined;
  },
) {
  function take(summary: ComputerSummary) {
    return summary.turns.get(input.turnId)?.firstStart?.event.data;
  }
  const recorded = await readStreamSummary(store, silo, `computer-${input.assistantId}`,
    computerSummary, Infinity, take);
  const choice = recordedChoiceSchema.safeParse(recorded);
  if (input.providerId === undefined && input.bindingSequence === undefined &&
    !choice.success) {
    return;
  }
  const claimedChoice = {
    providerId: input.providerId, bindingSequence: input.bindingSequence,
  };
  const claimed = providerTurnBindingSchema.parse(claimedChoice);
  const saved = recordedChoiceSchema.parse(recorded);
  if (saved.providerId !== claimed.providerId ||
    saved.bindingSequence !== claimed.bindingSequence ||
    saved.model !== input.model || saved.task !== input.task) {
    throw new Error('Recorded turn provider choice mismatch');
  }
}
