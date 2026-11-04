import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { ChatIcon } from './icon';
import {
  toolActivityResult, toolActivityResultLabel, toolKind, type ToolActivityRecord,
} from './chat-state';
import { utcDateTime } from './file-presentation';

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
  protected readonly expanded = signal(false);
  protected readonly toolResult = toolActivityResult;
  protected readonly toolResultLabel = toolActivityResultLabel;
  protected readonly toolKind = toolKind;
  protected readonly toolTime = utcDateTime;

  protected stateName(): string {
    const record = this.record();
    if (record.status === 'running') return 'running';
    if (record.status === 'unconfirmed') return 'unconfirmed';
    if (record.failed) return 'failed';
    return 'done';
  }

  protected stateIcon(): string {
    if (this.record().status === 'running') return 'working';
    if (this.record().status === 'unconfirmed') return 'clock';
    if (this.record().failed) return 'failed';
    return 'done';
  }

  protected lineLabel(): string {
    const record = this.record();
    if (record.nativeRequestId) {
      const server = record.serverName ? ` · ${record.serverName}` : '';
      return `Unsupported native consent · Request ${record.nativeRequestId}${server}`;
    }
    if (record.status === 'running') return `${record.label} · Running`;
    if (record.status === 'unconfirmed') return `${record.label} · Unconfirmed`;
    if (record.status === 'completed') return `${record.label} · Completed`;
    if (record.status === 'failed') return `${record.label} · Failed`;
    if (record.status === 'finished') return `${record.label} · Finished`;
    return record.label;
  }

  protected openDetails(event: MouseEvent): void {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    if (this.record().nativeRequestId) {
      this.detailsOpened.emit(event.currentTarget);
      return;
    }
    this.expanded.set(!this.expanded());
  }
}
