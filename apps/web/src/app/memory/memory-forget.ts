import { ChangeDetectionStrategy, Component, input, output, signal, type OnDestroy } from
  '@angular/core';
import { ModalSheet } from '../ui/modal-sheet';
import { isObject } from './memory-panel-data';

export type ForgetTarget = { scopeId: string; memoryId: string; revision: number;
  opener: HTMLElement };
type ForgetState = 'review' | 'sending' | 'unknown' | 'conflict' | 'pending' |
  'forgotten' | 'unavailable';
type Receipt = { operation: 'forget'; outcome: 'accepted'; hidden: true;
  memoryId: string; scopeId: string; cleanupStatus: 'pending' | 'forgotten' |
  'unavailable'; forgottenAt?: string };

@Component({
  selector: 'oc-memory-forget',
  imports: [ModalSheet],
  templateUrl: './memory-forget.html',
  styleUrl: './memory-forget.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MemoryForget implements OnDestroy {
  readonly target = input.required<ForgetTarget>();
  readonly accepted = output<ForgetTarget>();
  readonly reviewLatest = output<ForgetTarget>();
  readonly closed = output<ForgetTarget>();
  readonly accessLost = output<ForgetTarget>();
  protected readonly state = signal<ForgetState>('review');
  protected readonly forgottenAt = signal('');
  private commandId: string | undefined;
  private alive = true;
  private acceptedOnce = false;

  ngOnDestroy(): void { this.alive = false; }

  protected cancel(): void {
    if (this.state() !== 'review') return;
    this.closed.emit(this.target());
  }

  protected async confirm(): Promise<void> {
    if (this.state() !== 'review') return;
    const target = this.target();
    const commandId = `mem_${crypto.randomUUID()}`;
    this.commandId = commandId;
    this.state.set('sending');
    const url = `/api/memory/${encodeURIComponent(target.scopeId)}/facts/` +
      `${encodeURIComponent(target.memoryId)}/forget`;
    const body = JSON.stringify({ commandId, expectedRevision: target.revision });
    try {
      const response = await fetch(url, { method: 'POST', credentials: 'same-origin',
        cache: 'no-store', headers: { 'content-type': 'application/json' }, body });
      await this.readReply(response);
    } catch {
      if (this.alive) this.state.set('unknown');
    }
  }

  protected async checkStatus(): Promise<void> {
    if (!this.commandId || this.state() === 'sending') return;
    const target = this.target();
    const url = `/api/memory/${encodeURIComponent(target.scopeId)}/changes/` +
      encodeURIComponent(this.commandId);
    if (!this.acceptedOnce) this.state.set('sending');
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      await this.readReply(response);
    } catch {
      if (this.alive && !this.acceptedOnce) this.state.set('unknown');
    }
  }

  protected review(): void { this.reviewLatest.emit(this.target()); }

  protected formatDate(): string {
    const date = new Date(this.forgottenAt());
    if (Number.isNaN(date.getTime())) return 'Date unavailable';
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(date) + ' UTC';
  }

  private async readReply(response: Response): Promise<void> {
    if (!this.alive) return;
    if ([401, 403, 404].includes(response.status)) {
      this.accessLost.emit(this.target());
      return;
    }
    if (response.status === 409) {
      if (!this.acceptedOnce) this.state.set('conflict');
      return;
    }
    if (!response.ok) {
      if (!this.acceptedOnce) this.state.set('unknown');
      return;
    }
    const body: unknown = await response.json();
    if (!this.alive) return;
    this.applyBody(body);
  }

  private applyBody(body: unknown): void {
    if (isObject(body) && body['outcome'] === 'conflict') {
      if (!this.acceptedOnce) this.state.set('conflict');
      return;
    }
    if (isReceipt(body) && body.memoryId === this.target().memoryId &&
      body.scopeId === this.target().scopeId) {
      this.forgottenAt.set(body.forgottenAt ?? '');
      this.state.set(body.cleanupStatus);
      if (!this.acceptedOnce) {
        this.acceptedOnce = true;
        this.accepted.emit(this.target());
      }
      return;
    }
    if (!this.acceptedOnce) this.state.set('unknown');
  }
}

function isReceipt(value: unknown): value is Receipt {
  if (!isObject(value)) return false;
  if (value['cleanupStatus'] === 'forgotten' &&
    typeof value['forgottenAt'] !== 'string') return false;
  return value['operation'] === 'forget' &&
    value['outcome'] === 'accepted' && value['hidden'] === true &&
    typeof value['memoryId'] === 'string' && typeof value['scopeId'] === 'string' &&
    ['pending', 'forgotten', 'unavailable'].includes(String(value['cleanupStatus']));
}
