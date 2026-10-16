import { ChangeDetectionStrategy, Component, effect, input, output, signal } from '@angular/core';
import { ModelAccessEditor, type AccessOutcome } from './model-access-editor';
import type { ProviderRow } from './provider-api';
import { formatTime, providerFacts } from './provider-display';

@Component({
  selector: 'oc-provider-setup-access',
  imports: [ModelAccessEditor],
  templateUrl: './provider-setup-access.html',
  styleUrl: './provider-setup.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProviderSetupAccess {
  readonly models = input<string[]>([]);
  readonly provider = input<ProviderRow>();
  readonly active = input(false);
  readonly done = input(false);
  protected readonly started = signal(false);
  readonly modelsCurrent = input(false);
  readonly lostAccess = output<void>();
  protected readonly outcomes = signal<AccessOutcome[]>([]);
  protected readonly facts = providerFacts;
  protected readonly time = formatTime;

  constructor() {
    effect(this.start.bind(this));
  }
  private start(): void {
    if (this.active()) this.started.set(true);
  }
  protected record(outcome: AccessOutcome): void {
    const rows: AccessOutcome[] = [];
    for (const row of this.outcomes()) {
      if (row.modelId === outcome.modelId && row.grantee.granteeId === outcome.grantee.granteeId
        && row.grantee.granteeKind === outcome.grantee.granteeKind) continue;
      rows.push(row);
    }
    this.outcomes.set([...rows, outcome]);
  }
  protected missing(outcome: AccessOutcome): boolean {
    return outcome.grantee.granteeKind === 'assistant'
      && !(outcome.operation === 'grant' && outcome.phase === 'saved');
  }
  protected label(outcome: AccessOutcome): string {
    if (outcome.phase === 'saved') return outcome.operation === 'grant' ? '✓' : 'Removed';
    if (outcome.phase === 'applying') return 'Applying';
    if (outcome.phase === 'unknown') return 'Outcome unknown';
    if (outcome.phase === 'conflict') return 'Review / Refresh';
    return 'Not saved';
  }
}
