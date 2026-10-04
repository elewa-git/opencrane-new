import { ChangeDetectionStrategy, Component, signal, type OnInit } from '@angular/core';
import { budgetCommandSchema, budgetSummarySchema, type BudgetSummary } from '@opencrane/protocol';
import { z } from 'zod';
import { SharedState, type PresentationState } from '../shared-state/shared-state';
import { DogEar } from '../ui/paper';

const responseSchema = z.object({ budget: budgetSummarySchema, models: z.array(z.object({ id: z.string(), retired: z.boolean().optional() })) });
@Component({
  selector: 'oc-models', imports: [SharedState, DogEar],
  templateUrl: './models.html', styleUrl: './models.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModelsScreen implements OnInit {
  protected readonly budget = signal<BudgetSummary | undefined>(undefined);
  protected readonly models = signal<string[]>([]);
  protected readonly state = signal<'loading' | 'ready' | 'pending' | 'error' | 'access'>('loading');
  protected readonly message = signal('Loading budgets…');
  protected readonly statusKind = signal<PresentationState>('checking');
  protected readonly evidenceAt = signal<string | undefined>(undefined);
  protected readonly changeReference = signal('');
  protected scope: 'global' | 'paying_group' | 'assistant' = 'global';
  protected scopeId = '';
  protected monthly = '20000';
  protected daily = '2000';
  protected defaultGroup = '';
  ngOnInit() { void this.load(); }
  protected money(cents: number) { return `€${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`; }
  protected select(scope: string) {
    this.scope = z.enum(['global', 'paying_group', 'assistant']).parse(scope);
    this.scopeId = ''; this.monthly = this.scope === 'global' ? String(this.budget()?.ceilingCents ?? 20000) : '';
  }
  protected async load() {
    this.state.set('loading');
    this.statusKind.set('checking');
    this.evidenceAt.set(undefined);
    this.message.set('Loading budgets…');
    try {
      const response = await fetch('/api/org/models');
      if (this.accessChanged(response)) return;
      if (!response.ok) throw new Error('Unavailable');
      const raw: unknown = await response.json(), result = responseSchema.parse(raw);
      this.accept(result.budget); this.models.set(result.models.filter(m => !m.retired).map(m => m.id));
      this.statusKind.set('ready');
      // This dates the budget read, not provider readiness.
      this.evidenceAt.set(new Date().toISOString());
      this.message.set('Budgets loaded');
    } catch {
      this.state.set('error');
      this.statusKind.set('failed');
      this.message.set('Could not load budgets. Check status before editing.');
    }
  }
  protected async save(event: Event) {
    event.preventDefault();
    const budget = this.budget();
    if (!budget || this.state() !== 'ready') return;
    const input = budgetCommandSchema.safeParse({ commandId: crypto.randomUUID(), expectedSequence: budget.sequence,
      scope: this.scope, ceilingCents: this.monthly.trim() ? Number(this.monthly) : NaN,
      ...(this.scope === 'global' ? { dailyCeilingCents: this.daily.trim() ? Number(this.daily) : NaN, defaultPayingGroupId: this.defaultGroup }
        : { scopeId: this.scopeId }) });
    if (!input.success) {
      this.statusKind.set('needs_input');
      this.evidenceAt.set(undefined);
      this.message.set('Enter a valid id and non-negative whole euro cents in the safe integer range.');
      return;
    }
    this.state.set('pending');
    this.statusKind.set('applying');
    this.evidenceAt.set(undefined);
    this.changeReference.set(input.data.commandId);
    this.message.set('Saving budget…');
    try {
      const response = await fetch('/api/org/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input.data) });
      if (this.accessChanged(response)) return;
      if (!response.ok) throw new Error('Unconfirmed');
      const raw: unknown = await response.json();
      this.accept(z.object({ budget: budgetSummarySchema }).parse(raw).budget);
      this.statusKind.set('confirmed');
      this.evidenceAt.set(new Date().toISOString());
      this.message.set('Budget saved');
    } catch {
      this.state.set('error');
      this.statusKind.set('unknown');
      this.message.set('Could not confirm the change. Check status before editing again.');
    }
  }
  private accept(budget: BudgetSummary) {
    this.budget.set(budget); this.defaultGroup = budget.defaultPayingGroupId ?? '';
    if (this.scope === 'global') this.monthly = String(budget.ceilingCents);
    this.daily = String(budget.dailyCeilingCents); this.state.set('ready');
  }
  private accessChanged(response: Response) {
    if (![401, 403].includes(response.status)) return false;
    this.budget.set(undefined); this.models.set([]); this.defaultGroup = ''; this.scopeId = '';
    this.state.set('access');
    this.statusKind.set('access_changed');
    this.evidenceAt.set(undefined);
    this.changeReference.set('');
    this.message.set('Access changed. Ask an Owner or Admin.');
    return true;
  }
}
