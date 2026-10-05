import { ChangeDetectionStrategy, Component } from '@angular/core';
import { SharedState } from '../shared-state/shared-state';

@Component({
  selector: 'oc-budget-stop-notice',
  imports: [SharedState],
  templateUrl: './budget-stop-notice.html',
  styleUrl: './budget-stop-notice.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BudgetStopNotice {
}
