import { vi } from 'vitest';
import type { BudgetActor } from '../src/actor.ts';
import * as authority from '../src/authority.ts';

const fixedReasons = new Set([
  'Model call retry refused', 'Root budget refused', 'Authority snapshot expired',
  'Authority changed', 'Decision audit unavailable', 'Request refused',
  'IAM projection behind', 'Current authority refused', 'Provider custody unavailable',
  'Request refused or decision service unavailable',
]);
function safeReason(error: unknown) {
  if (error instanceof Error && fixedReasons.has(error.message)) {
    return error.message;
  }
  return 'Unclassified refusal';
}

export function retryDiagnostics(actor: BudgetActor) {
  let stage = 'before access check';
  let reason = 'No actor refusal';
  const checkAuthority = authority.currentAuthority;
  async function observeAuthority(...args: Parameters<typeof checkAuthority>) {
    stage = 'access check';
    try {
      return await checkAuthority(...args);
    } catch (error) {
      reason = safeReason(error);
      throw error;
    }
  }
  const authoritySpy = vi.spyOn(authority, 'currentAuthority');
  authoritySpy.mockImplementation(observeAuthority);
  const reserve = actor.reserve.bind(actor);
  const admit = actor.admitDispatch.bind(actor);
  async function observeReserve(...args: Parameters<typeof reserve>) {
    stage = 'reservation';
    try {
      const result = await reserve(...args);
      stage = 'decision recovery';
      return result;
    } catch (error) {
      reason = safeReason(error);
      const [call, amount, , , rootId, retry] = args;
      for (const saved of actor.state.reservations) {
        if (saved.retryDigest !== retry?.retryDigest) continue;
        if (saved.call.contextDigest !== call.contextDigest) reason = 'Retry context changed';
        if (saved.rootId !== rootId) reason = 'Retry root changed';
        if (saved.amountCents !== amount) reason = 'Retry amount changed';
        if (saved.bodyDigest !== retry?.bodyDigest) reason = 'Retry body changed';
      }
      throw error;
    }
  }
  async function observeAdmission(...args: Parameters<typeof admit>) {
    stage = 'admission';
    try {
      await admit(...args);
      stage = 'gateway response';
    } catch (error) {
      reason = safeReason(error);
      throw error;
    }
  }
  const reserveSpy = vi.spyOn(actor, 'reserve');
  reserveSpy.mockImplementation(observeReserve);
  const admissionSpy = vi.spyOn(actor, 'admitDispatch');
  admissionSpy.mockImplementation(observeAdmission);
  function message(responseText: string) {
    if (reason === 'No actor refusal') {
      for (const fixedReason of fixedReasons) {
        if (responseText.includes(`"error":${JSON.stringify(fixedReason)}`)) {
          reason = fixedReason;
        }
      }
    }
    return `Refusal stage: ${stage}; fixed reason: ${reason}`;
  }
  return message;
}
