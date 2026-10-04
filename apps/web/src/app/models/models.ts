import { ChangeDetectionStrategy, Component, signal, type OnInit } from '@angular/core';
import { budgetCommandSchema, budgetSummarySchema, type BudgetSummary } from '@opencrane/protocol';
import { z } from 'zod';
import { SharedState, type PresentationState } from '../shared-state/shared-state';
import { DogEar } from '../ui/paper';

const modelSchema = z.object({ id: z.string(), retired: z.boolean().optional() });
const responseSchema = z.object({ budget: budgetSummarySchema, models: z.array(modelSchema) });
const savedSchema = z.object({ budget: budgetSummarySchema });

function isCurrentModel(model: z.infer<typeof modelSchema>): boolean {
  return !model.retired;
}

function modelId(model: z.infer<typeof modelSchema>): string {
  return model.id;
}

function centsInput(value: string): number {
  if (!value.trim()) return NaN;
  return Number(value);
}

@Component({
  selector: 'oc-models',
  imports: [SharedState, DogEar],
  templateUrl: './models.html',
  styleUrl: './models.css',
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

  ngOnInit(): void {
    void this.load();
  }

  protected money(cents: number): string {
    const euros = Math.trunc(cents / 100);
    const remainder = String(cents % 100).padStart(2, '0');
    return `€${euros}.${remainder}`;
  }

  protected select(scope: string): void {
    this.scope = z.enum(['global', 'paying_group', 'assistant']).parse(scope);
    this.scopeId = '';
    this.monthly = '';
    if (this.scope === 'global') this.monthly = String(this.budget()?.ceilingCents ?? 20000);
  }

  protected async load(): Promise<void> {
    this.state.set('loading');
    this.statusKind.set('checking');
    this.evidenceAt.set(undefined);
    this.message.set('Loading budgets…');
    try {
      const response = await fetch('/api/org/models');
      if (this.accessChanged(response)) return;
      if (!response.ok) throw new Error('Unavailable');
      const raw: unknown = await response.json();
      const result = responseSchema.parse(raw);
      this.accept(result.budget);
      const currentModels = result.models.filter(isCurrentModel);
      const modelIds = currentModels.map(modelId);
      this.models.set(modelIds);
      this.statusKind.set('ready');
      // This dates the projection read, not provider readiness or an external effect.
      this.evidenceAt.set(new Date().toISOString());
      this.message.set('Budget projection read');
    } catch {
      this.state.set('error');
      this.statusKind.set('failed');
      this.message.set('Could not load budgets. Check status before editing.');
    }
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    const budget = this.budget();
    if (!budget || this.state() !== 'ready') return;
    const command = this.budgetInput(budget);
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
    const options: RequestInit = {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input.data),
    };
    try {
      const response = await fetch('/api/org/models', options);
      if (this.accessChanged(response)) return;
      if (!response.ok) throw new Error('Unconfirmed');
      const raw: unknown = await response.json();
      const result = savedSchema.parse(raw);
      this.accept(result.budget);
      this.statusKind.set('confirmed');
      this.evidenceAt.set(new Date().toISOString());
      this.message.set('Saved budget projection read');
    } catch {
      this.state.set('error');
      this.statusKind.set('unknown');
      this.message.set('Could not confirm the change. Check status before editing again.');
    }
  }

  private budgetInput(budget: BudgetSummary): unknown {
    const command = {
      commandId: crypto.randomUUID(), expectedSequence: budget.sequence,
      scope: this.scope, ceilingCents: centsInput(this.monthly),
    };
    if (this.scope === 'global') {
      return {
        ...command, dailyCeilingCents: centsInput(this.daily),
        defaultPayingGroupId: this.defaultGroup,
      };
    }
    return { ...command, scopeId: this.scopeId };
  }

  private accept(budget: BudgetSummary): void {
    this.budget.set(budget);
    this.defaultGroup = budget.defaultPayingGroupId ?? '';
    if (this.scope === 'global') this.monthly = String(budget.ceilingCents);
    this.daily = String(budget.dailyCeilingCents);
    this.state.set('ready');
  }

  private accessChanged(response: Response): boolean {
    if (response.status !== 401 && response.status !== 403) return false;
    this.budget.set(undefined);
    this.models.set([]);
    this.defaultGroup = '';
    this.scopeId = '';
    this.changeReference.set('');
    this.state.set('access');
    this.statusKind.set('access_changed');
    this.evidenceAt.set(undefined);
    this.message.set('Access changed. Ask an Owner or Admin.');
    return true;
  }
}
