import { createHash } from 'node:crypto';
import { z } from 'zod';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { tokenVerifier } from '@opencrane/auth';
import type { JSONWebKeySet } from 'jose';
import { BudgetActor, history } from './actor.ts';
import { authorityFence } from './authority.ts';
import { budgetSummary, data } from './state.ts';

export class BudgetAccessRefused extends Error {}
const claims = z.object({ typ: z.literal('budget-admin'), silo: z.string(), memberId: z.string(), commandDigest: z.string() });
/** The server signs the exact command after session/Origin checks; identity alone is never authority. */
export async function configureBudget(actor: BudgetActor, binding: Binding, identity: { jwks: JSONWebKeySet; issuer: string }, raw: unknown, authorization?: string) {
  const started = performance.now();
  const checked = await verifyCommand(identity, authorization);
  const fresh = await authorityFence(actor.store, started, [`member-${checked.memberId}`]);
  if (checked.silo !== actor.silo || binding.silo !== actor.silo || checked.commandDigest !== createHash('sha256').update(JSON.stringify(raw)).digest('hex')) throw new BudgetAccessRefused('Access changed');
  const permission = await memberAuthorisation(binding).check(checked.memberId, 'admin');
  if (permission.status === 'unavailable') throw new Error('Budget authority unavailable');
  if (!permission.allowed) throw new BudgetAccessRefused('Access changed');
  const membership = await history(actor.store, `member-${checked.memberId}`, actor.silo);
  const last = membership.filter(r => ['member.joined', 'silo.owner_bootstrapped', 'member.role_changed', 'member.removed'].includes(r.event.type)).at(-1);
  const member = last ? data(last.event) : {};
  if (last?.event.type === 'member.removed' || !['owner', 'admin'].includes(String(member['newRole'] ?? member['role']))) throw new BudgetAccessRefused('Access changed');
  const { commandId, expectedSequence, ...payload } = z.object({ commandId: z.string().regex(/^[\w-]{1,200}$/u), expectedSequence: z.int().nonnegative() }).passthrough().parse(raw);
  const result = await actor.configure({ ...payload, setBy: checked.memberId }, commandId, expectedSequence, fresh);
  return { ...result, budget: budgetSummary(actor.state, actor.now()) };
}

async function verifyCommand(identity: { jwks: JSONWebKeySet; issuer: string }, authorization?: string) {
  try {
    return claims.parse(await tokenVerifier(identity.jwks, identity.issuer).verify(authorization?.replace(/^Bearer /u, '') ?? '', 'budget-admin'));
  } catch { throw new BudgetAccessRefused('Invalid budget command capability'); }
}
