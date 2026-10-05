import {
  ChangeDetectionStrategy, Component, signal, type OnInit, type OnDestroy,
} from '@angular/core';
import { budgetCommandSchema, budgetSummarySchema, type BudgetSummary } from '@opencrane/protocol';
import { z } from 'zod';
import { SharedState, type PresentationState } from '../shared-state/shared-state';
import { DogEar } from '../ui/paper';

const responseSchema = z.object({ budget: budgetSummarySchema });
const scopeSchema = z.enum(['global', 'paying_group', 'assistant']);

@Component({
  selector: 'oc-spending',
  imports: [SharedState, DogEar],
  templateUrl: './spending.html',
  styleUrl: './spending.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpendingScreen implements OnInit, OnDestroy {
  protected readonly budget = signal<BudgetSummary | undefined>(undefined);
  protected readonly state = signal<'loading' | 'ready' | 'pending' | 'error' | 'access'>('loading');
  protected readonly message = signal('Loading spending…');
  protected readonly statusKind = signal<PresentationState>('checking');
  protected readonly evidenceAt = signal<string | undefined>(undefined);
  protected readonly changeReference = signal('');
  protected scope: z.infer<typeof scopeSchema> = 'global';
  protected scopeId = '';
  protected monthly = '';
  protected daily = '';
  protected defaultGroup = '';
  private readonly request = new AbortController();

  ngOnInit(): void {
    void this.load();
  }

  ngOnDestroy(): void {
    this.request.abort();
  }

  protected money(cents: number): string {
    const euros = Math.trunc(cents / 100);
    const remainder = String(cents % 100).padStart(2, '0');
    return `€${euros}.${remainder}`;
  }

  protected select(scope: string): void {
    this.scope = scopeSchema.parse(scope);
    this.scopeId = '';
    this.monthly = '';
    const budget = this.budget();
    if (this.scope === 'global' && budget) {
      this.monthly = String(budget.ceilingCents);
    }
  }

  protected async load(): Promise<void> {
    if (this.state() === 'pending') {
      return;
    }
    this.state.set('loading');
    this.statusKind.set('checking');
    this.evidenceAt.set(undefined);
    this.message.set('Loading spending…');
    try {
      const response = await fetch('/api/org/models', { signal: this.request.signal });
      if (this.request.signal.aborted || this.accessChanged(response)) {
        return;
      }
      if (!response.ok) {
        throw new Error('Unavailable');
      }
      const raw: unknown = await response.json();
      if (this.request.signal.aborted) {
        return;
      }
      const result = responseSchema.parse(raw);
      this.accept(result.budget);
      this.statusKind.set('ready');
      // The timestamp dates this read, not a provider or budget completion event.
      this.evidenceAt.set(new Date().toISOString());
      this.message.set('Spending loaded');
    } catch {
      if (this.request.signal.aborted) {
        return;
      }
      this.state.set('error');
      this.statusKind.set('failed');
      this.message.set('Could not load budgets. Check status before editing.');
    }
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    const budget = this.budget();
    if (!budget || this.state() !== 'ready') {
      return;
    }
    const command = this.budgetCommand(budget);
    const input = budgetCommandSchema.safeParse(command);
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
      const options = {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input.data), signal: this.request.signal,
      };
      const response = await fetch('/api/org/models', options);
      if (this.request.signal.aborted || this.accessChanged(response)) {
        return;
      }
      if (!response.ok) {
        throw new Error('Unconfirmed');
      }
      const raw: unknown = await response.json();
      if (this.request.signal.aborted) {
        return;
      }
      const result = responseSchema.parse(raw);
      this.accept(result.budget);
      this.statusKind.set('confirmed');
      this.evidenceAt.set(new Date().toISOString());
      this.message.set('Budget saved');
    } catch {
      if (this.request.signal.aborted) {
        return;
      }
      this.state.set('error');
      this.statusKind.set('unknown');
      this.message.set('Could not confirm the change. Check status before editing again.');
    }
  }

  private budgetCommand(budget: BudgetSummary): unknown {
    const command = {
      commandId: crypto.randomUUID(), expectedSequence: budget.sequence,
      scope: this.scope, ceilingCents: this.wholeCents(this.monthly),
    };
    if (this.scope === 'global') {
      return {
        ...command, dailyCeilingCents: this.wholeCents(this.daily),
        defaultPayingGroupId: this.defaultGroup,
      };
    }
    return { ...command, scopeId: this.scopeId };
  }

  private wholeCents(value: string): number {
    if (!value.trim()) {
      return NaN;
    }
    return Number(value);
  }

  private accept(budget: BudgetSummary): void {
    this.budget.set(budget);
    this.defaultGroup = budget.defaultPayingGroupId ?? '';
    if (this.scope === 'global') {
      this.monthly = String(budget.ceilingCents);
    }
    this.daily = String(budget.dailyCeilingCents);
    this.state.set('ready');
  }

  private accessChanged(response: Response): boolean {
    if (![401, 403].includes(response.status)) {
      return false;
    }
    this.budget.set(undefined);
    this.defaultGroup = '';
    this.scopeId = '';
    this.monthly = '';
    this.daily = '';
    this.state.set('access');
    this.statusKind.set('access_changed');
    this.evidenceAt.set(undefined);
    this.changeReference.set('');
    this.message.set('Access changed. Ask an Owner or Admin.');
    return true;
  }
}
