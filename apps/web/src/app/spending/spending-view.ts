import type { BudgetEditorLoadState } from './budget-limit-editor';
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
