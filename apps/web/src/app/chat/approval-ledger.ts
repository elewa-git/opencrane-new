import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { ApprovalCard } from '@opencrane/protocol';
import { utcDateTime } from './file-presentation';

@Component({
  selector: 'oc-approval-ledger',
  templateUrl: './approval-ledger.html',
  styleUrl: './approval-ledger.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ApprovalLedger {
  readonly card = input.required<ApprovalCard>();
  readonly viewerId = input.required<string>();

  protected utcDateTime(value: string): string {
    return utcDateTime(value);
  }

  protected requester(): string {
    if (this.card().requesterId === this.viewerId()) {
      return 'You';
    }
    return 'Another participant';
  }
}
