import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { SharedState } from '../shared-state/shared-state';

@Component({
  selector: 'oc-approval-decision-status',
  imports: [SharedState],
  template: `
    <p class="decision-status" role="status">{{ message() }}</p>
    @if (showReference()) {
      <p class="decision-reference">Reference <code>{{ reference() }}</code></p>
    }
    @if (showCheck()) {
      <oc-shared-state class="decision-state unknown-notice" kind="unknown"
        message="Decision not confirmed"
        detail="The server did not confirm your decision. Check its status before deciding again."
        [actionBusy]="busy()" (action)="checkRequested.emit()" />
    }
  `,
  styles: `
    .decision-status { margin: 8px 0; color: var(--oc-ink-muted); font-size: 12px; }
    .decision-reference { margin: 4px 0; color: var(--oc-ink-muted); font-size: 11px; }
    code { font-family: var(--oc-font-mono); overflow-wrap: anywhere; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ApprovalDecisionStatus {
  readonly message = input('');
  readonly showCheck = input(false);
  readonly showReference = input(false);
  readonly reference = input('');
  readonly busy = input(false);
  readonly checkRequested = output<void>();
}
