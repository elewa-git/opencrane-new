import type { BudgetEditorLoadState } from './budget-limit-editor';
import type { EffectStatus } from '@opencrane/protocol';
import { utcClockTime } from './effect-rules';
import type { ReadResult } from './spending-reads';

export function lostReplyMessage(permitId: string, commandId: string): string {
  return `We couldn't tell whether the resolution for ${permitId} was recorded. Check its status before sending again. Command reference: ${commandId}.`;
}

export function readStateFor<T>(result: ReadResult<T>): BudgetEditorLoadState {
  if (result.state === 'ready') return 'ready';
  if (result.state === 'unavailable') return 'unavailable';
  return 'failed';
}

export function spendingPageStatus(
  budgetState: BudgetEditorLoadState,
  effectsState: BudgetEditorLoadState,
): string {
  if (budgetState === 'loading' || effectsState === 'loading') {
    return 'Loading spending…';
  }
  if (budgetState === 'failed' || budgetState === 'unavailable'
    || effectsState === 'failed' || effectsState === 'unavailable') {
    return 'Some spending information could not be loaded. Check the sections below.';
  }
  return 'Spending loaded';
}

export function heldEffects(effects: EffectStatus[]): EffectStatus[] {
  const held: EffectStatus[] = [];
  for (const effect of effects) {
    const needsReview = effect.state === 'outcome_unknown'
      && (effect.reasons.length > 0 || effect.conflict);
    const resolutionIsWaiting = effect.state === 'resolution_pending';
    if (needsReview || resolutionIsWaiting) held.push(effect);
  }
  return held;
}

export function waitingCount(effects: EffectStatus[]): number {
  let count = 0;
  for (const effect of effects) {
    const waitsForUsage = effect.state === 'outcome_unknown'
      && effect.reasons.length === 0 && !effect.conflict;
    if (waitsForUsage) count += 1;
  }
  return count;
}

export function loadedTime(value: string | undefined): string {
  if (!value) return '';
  return utcClockTime(value);
}

export function findEffect(
  effects: EffectStatus[], permitId: string,
): EffectStatus | undefined {
  for (const effect of effects) {
    if (effect.permitId === permitId) return effect;
  }
  return undefined;
}

export function sendingResolutionMessage(commandId: string): string {
  return `A resolution for this hold is still being sent. Its reference is ${commandId}.`;
}
