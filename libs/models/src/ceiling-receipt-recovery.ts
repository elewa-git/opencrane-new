import type { StoredEvent } from '@opencrane/event-store';
import type { EventEnvelope } from '@opencrane/events';
import { ceilingReceipt } from './ceiling-command.ts';
import { applyBudget, type BudgetState } from './state.ts';

export class CeilingReceiptRecovery {
  private lastCeiling: StoredEvent | undefined;

  apply(event: EventEnvelope, sequence: number, state: BudgetState) {
    if (event.type === 'budget.ceiling_set') {
      this.lastCeiling = { event, sequence };
    }
    applyBudget(state, event, sequence);
  }

  receipt(state: BudgetState) {
    return ceilingReceipt(this.lastCeiling!, state);
  }
}
