import { activeMember, MemberAccessRefused } from './member-authority.ts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import { tokenVerifier } from '@opencrane/auth';
import type { JSONWebKeySet } from 'jose';
import { BudgetActor } from './actor.ts';
import { currentMembership } from './ownership.ts';
import { authorityFence } from './authority.ts';
import { budgetSummary } from './state.ts';
import { budgetCommandSchema } from '@opencrane/protocol';
import { budgetScope, BudgetAccessRefused, BudgetChoiceRefused } from './budget-scope.ts';

const claims = z.object({ typ: z.enum(['budget-admin', 'provider-verification']),
  silo: z.string(), memberId: z.string(), commandDigest: z.string() });
/** The server signs the exact command after session and Origin checks. */
export async function configureBudget(actor: BudgetActor, binding: Binding,
  identity: { jwks: JSONWebKeySet; issuer: string }, raw: unknown, authorization?: string) {
  const checked = await verifyCommand(identity, raw, actor.silo, authorization);
  if (binding.silo !== actor.silo) {
    throw new BudgetAccessRefused('Access changed');
  }
  let fresh: Awaited<ReturnType<typeof authorityFence>> | undefined;
  async function confirmAccess(newCommand = false) {
    if (!fresh) {
      let choiceUnavailable = false;
      let scopePositions = new Map<string, number>();
      try {
        if (newCommand) {
          scopePositions = await budgetScope(actor.store, actor.silo, raw);
        }
      } catch (error) {
        if (error instanceof MemberAccessRefused ||
            (error instanceof Error && error.message === 'Wrong silo')) {
          choiceUnavailable = true;
        } else {
          throw error;
        }
      }
      const membership = await currentMembership(actor.store, actor.silo, checked.memberId,
        undefined, performance.now() + 10_000);
      const subjects = [...membership.positions.keys(), ...scopePositions.keys()];
      fresh = await authorityFence(actor.store, performance.now(), subjects);
      // Refuse changes saved between loading the choices and starting the write check.
      for (const [subject, position] of scopePositions) {
        if (await actor.store.head(subject, fresh.deadline) !== position) {
          choiceUnavailable = true;
        }
      }
      const authority = { requiredRole: 'admin' as const, fresh, membership };
      try {
        await activeMember(actor.store, binding, checked.memberId, authority);
      } catch (error) {
        if (error instanceof MemberAccessRefused) {
          throw new BudgetAccessRefused(error.message);
        }
        throw error;
      }
      // Check the caller before reporting an invalid choice, so lost access still clears the page.
      if (choiceUnavailable) {
        throw new BudgetChoiceRefused('Spending choice unavailable');
      }
    }
    await fresh();
  }
  function currentDeadline() {
    return fresh?.deadline;
  }
  // Share the exact deadline once history preparation creates the access check.
  Object.defineProperty(confirmAccess, 'deadline', { get: currentDeadline });
  const { commandId, expectedSequence, ...payload } = budgetCommandSchema.parse(raw);
  const configuration = { ...payload, setBy: checked.memberId };
  const result = await actor.configure(configuration, commandId, expectedSequence, confirmAccess);
  return { ...result, budget: budgetSummary(actor.state, actor.now()) };
}

export async function verifyCommand(identity: { jwks: JSONWebKeySet; issuer: string },
  raw: unknown, silo: string, authorization?: string,
  audience: 'budget-admin' | 'provider-verification' = 'budget-admin') {
  try {
    const verifier = tokenVerifier(identity.jwks, identity.issuer);
    const token = authorization?.replace(/^Bearer /u, '') ?? '';
    const checked = claims.parse(await verifier.verify(token, audience));
    const hash = createHash('sha256');
    hash.update(JSON.stringify(raw));
    const digest = hash.digest('hex');
    if (checked.typ !== audience || checked.silo !== silo || checked.commandDigest !== digest) {
      throw new BudgetAccessRefused('Access changed');
    }
    return checked;
  } catch {
    throw new BudgetAccessRefused('Invalid command capability');
  }
}
