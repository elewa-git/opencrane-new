import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { ChatIcon } from './icon';
import type { ToolActivityRecord } from './chat-state';

@Component({
  selector: 'oc-tool-activity-line',
  imports: [ChatIcon],
  templateUrl: './tool-activity-line.html',
  styleUrl: './tool-activity-line.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolActivityLine {
  readonly record = input.required<ToolActivityRecord>();
  readonly detailsOpened = output<HTMLElement>();

  protected openDetails(event: MouseEvent): void {
    if (event.currentTarget instanceof HTMLElement) {
      this.detailsOpened.emit(event.currentTarget);
    }
  }
}
