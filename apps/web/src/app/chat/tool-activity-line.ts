import { ChangeDetectionStrategy, Component, input } from '@angular/core';
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
  protected toolName(): string {
    if (this.record().label === 'Reply failed') {
      return 'agent run';
    }
    return 'computer command';
  }

  protected result(): string {
    if (this.record().failed) {
      return `Failed · ${this.record().detail}`;
    }
    return `Completed · ${this.record().detail}`;
  }

  protected time(): string {
    const date = new Date(this.record().time);
    return date.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
