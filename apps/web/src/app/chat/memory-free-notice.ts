import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { SharedState } from '../shared-state/shared-state';

@Component({
  selector: 'oc-memory-free-notice',
  imports: [SharedState],
  templateUrl: './memory-free-notice.html',
  styleUrl: './memory-free-notice.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MemoryFreeNotice {
  readonly detail = input.required<string>();
  readonly memoryFreeSelected = output<void>();
}
