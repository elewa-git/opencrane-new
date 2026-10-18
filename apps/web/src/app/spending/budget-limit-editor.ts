import { ChangeDetectionStrategy, Component, input, output, type SimpleChanges } from '@angular/core';
import type { BudgetSummary } from '@opencrane/protocol';
import { z } from 'zod';
import { SharedState } from '../shared-state/shared-state';
import { parseCents } from './effect-rules';
import type { SpendingReadState } from './spending-reads';

const scopeSchema = z.enum(['global', 'paying_group', 'assistant']);

export type BudgetEditorLoadState = SpendingReadState;
export type BudgetEditorSaveState = 'idle' | 'applying' | 'confirmed' | 'unknown' | 'needs_input'
  | 'choice_unavailable';

@Component({
  selector: 'oc-budget-limit-editor',
  imports: [SharedState],
  templateUrl: './budget-limit-editor.html',
  styleUrl: './budget-limit-editor.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BudgetLimitEditor {
  readonly budget = input.required<BudgetSummary>();
  readonly loadState = input.required<BudgetEditorLoadState>();
  readonly saveState = input.required<BudgetEditorSaveState>();
  readonly evidenceAt = input<string>();
  readonly changeReference = input('');
  readonly saveRequested = output<unknown>();
  readonly checkStatus = output<void>();

  protected scope: z.infer<typeof scopeSchema> = 'global';
  protected scopeId = '';
  protected monthly = '';
  protected daily = '';
  protected defaultGroup = '';

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['budget']) return;
    const current = this.budget();
    this.defaultGroup = current.defaultPayingGroupId ?? '';
    this.daily = String(current.dailyCeilingCents);
    if (this.scope === 'global') this.monthly = String(current.ceilingCents);
  }

  protected select(scope: string): void {
    this.scope = scopeSchema.parse(scope);
    this.scopeId = '';
    const current = this.budget();
    this.monthly = this.scope === 'global' ? String(current.ceilingCents) : '';
  }

  protected save(event: Event): void {
    event.preventDefault();
    this.saveRequested.emit(this.command());
  }

  private command(): unknown {
    const shared = {
      commandId: crypto.randomUUID(),
      expectedSequence: this.budget().sequence,
      scope: this.scope,
      ceilingCents: parseCents(this.monthly) ?? NaN,
    };
    if (this.scope === 'global') {
      return {
        ...shared,
        dailyCeilingCents: parseCents(this.daily) ?? NaN,
        defaultPayingGroupId: this.defaultGroup,
      };
    }
    return { ...shared, scopeId: this.scopeId };
  }
}
