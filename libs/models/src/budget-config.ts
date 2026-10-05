import { activeMember, MemberAccessRefused } from './member-authority.ts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import { tokenVerifier } from '@opencrane/auth';
import type { JSONWebKeySet } from 'jose';
import { BudgetActor } from './actor.ts';
import { authorityFence } from './authority.ts';
import { budgetSummary } from './state.ts';
import { providerIdSchema } from '@opencrane/events';

export class BudgetAccessRefused extends Error {}
const claims = z.object({ typ: z.enum(['budget-admin', 'provider-verification']),
  silo: z.string(), memberId: z.string(), commandDigest: z.string() });
const budgetCommand = z.object({ commandId: providerIdSchema,
  expectedSequence: z.int().nonnegative() }).passthrough();
/** The server signs the exact command after session and Origin checks. */
export async function configureBudget(actor: BudgetActor, binding: Binding,
  identity: { jwks: JSONWebKeySet; issuer: string }, raw: unknown, authorization?: string) {
  const started = performance.now();
  const checked = await verifyCommand(identity, raw, actor.silo, authorization);
  const fresh = await authorityFence(actor.store, started, [`member-${checked.memberId}`]);
  if (binding.silo !== actor.silo) {
    throw new BudgetAccessRefused('Access changed');
  }
  try {
    await activeMember(actor.store, binding, checked.memberId, true, fresh);
  } catch (error) {
    if (error instanceof MemberAccessRefused) {
      throw new BudgetAccessRefused(error.message);
    }
    throw error;
  }
  const { commandId, expectedSequence, ...payload } = budgetCommand.parse(raw);
  const configuration = { ...payload, setBy: checked.memberId };
  const result = await actor.configure(configuration, commandId, expectedSequence, fresh);
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
