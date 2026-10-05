import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { ChatIcon } from './icon';

export interface ToolActivityRecord {
  id: string;
  label: string;
  detail: string;
  failed: boolean;
  time: string;
}

@Component({
  selector: 'oc-tool-activity-line',
  imports: [ChatIcon],
  templateUrl: './tool-activity-line.html',
  styleUrl: './tool-activity-line.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolActivityLine {
  readonly record = input.required<ToolActivityRecord>();
  readonly detailsOpened = output<string>();

  protected toggleDetails(event: Event, details: HTMLDetailsElement): void {
    event.preventDefault();
    details.open = !details.open;
    if (details.open) {
      this.detailsOpened.emit(this.record().id);
    }
  }

  protected toolName(): string {
    if (this.record().label === 'Reply failed') {
      return 'agent run';
    }
    return 'computer command';
  }

  protected result(): string {
    if (this.record().failed) {
      return `execution · ${this.record().detail}`;
    }
    return `none · ${this.record().detail}`;
  }

  protected time(): string {
    const date = new Date(this.record().time);
    return date.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
