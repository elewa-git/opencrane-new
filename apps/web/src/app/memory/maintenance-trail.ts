import { ChangeDetectionStrategy, Component, input, signal,
  type OnChanges, type OnDestroy, type SimpleChanges } from '@angular/core';
import { Overlay } from '../ui/overlay';
import { isObject } from './memory-panel-data';
import { readJson } from './memory-panel-reads';

type Run = { runId: string; action: string; reason?: string; intendedAt: string;
  selectedAt: string; observedAt: string | null; money: { status: string;
    heldCents?: number; settledCents?: number } };
type Detail = Run & { memberId: string; allowanceCents: number | null;
  startedAt: string | null };
type Page = { status: string; nextAt: string | null; history: Run[];
  nextCursor: string | null };

function isRun(value: unknown): value is Run {
  if (!isObject(value) || !isObject(value['money'])) return false;
  return typeof value['runId'] === 'string' && /^[a-f0-9]{64}$/u.test(value['runId']) &&
    typeof value['action'] === 'string' && typeof value['intendedAt'] === 'string' &&
    typeof value['selectedAt'] === 'string' &&
    (typeof value['observedAt'] === 'string' || value['observedAt'] === null) &&
    typeof value['money']['status'] === 'string';
}

function isPage(value: unknown): value is Page {
  return isObject(value) && typeof value['status'] === 'string' &&
    (typeof value['nextAt'] === 'string' || value['nextAt'] === null) &&
    Array.isArray(value['history']) && value['history'].every(isRun) &&
    (typeof value['nextCursor'] === 'string' || value['nextCursor'] === null);
}

function isDetail(value: unknown): value is Detail {
  if (!isRun(value)) return false;
  const fields = value as Record<string, unknown>;
  return typeof fields['memberId'] === 'string' &&
    (typeof fields['allowanceCents'] === 'number' || fields['allowanceCents'] === null) &&
    (typeof fields['startedAt'] === 'string' || fields['startedAt'] === null);
}

function label(action: string): string {
  if (action === 'prepared') return 'Saved for preparation';
  if (action === 'missed') return 'Missed';
  if (action === 'refused') return 'Refused';
  if (action === 'no_changes') return 'No changes';
  if (action === 'completed') return 'Completed';
  if (action === 'discarded') return 'Discarded';
  if (action === 'unknown') return 'Outcome unknown';
  if (action === 'due') return 'Scheduled';
  return 'Maintenance recorded';
}

function timeLabel(value: string | null): string {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unavailable';
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short',
    timeZone: 'UTC' }).format(date) + ' UTC';
}

function moneyLabel(cents: number | undefined): string {
  if (cents === undefined || !Number.isSafeInteger(cents) || cents < 0) return 'Unavailable';
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' })
    .format(cents / 100);
}

function statusLabel(status: string): string {
  if (status === 'qualification_blocked') return 'Nightly maintenance is unavailable';
  if (status === 'not_configured') return 'Nightly maintenance is not set up';
  if (status === 'disabled') return 'Nightly maintenance is off';
  if (status === 'clean') return 'Nothing needs maintenance';
  if (status === 'preparing') return 'Preparation was saved';
  if (status === 'refused') return 'The latest run was refused';
  return 'Nightly maintenance';
}

@Component({
  selector: 'oc-maintenance-trail',
  imports: [Overlay],
  templateUrl: './maintenance-trail.html',
  styleUrl: './maintenance-trail.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MaintenanceTrail implements OnChanges, OnDestroy {
  readonly scopeId = input.required<string>();
  readonly audience = input.required<string>();
  readonly requesterId = input<string | undefined>();
  readonly accessDenied = input(false);
  protected readonly rows = signal<Run[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly status = signal('loading');
  protected readonly nextAt = signal<string | null>(null);
  protected readonly error = signal(false);
  protected readonly loading = signal(false);
  protected readonly selected = signal<Run | undefined>(undefined);
  protected readonly detail = signal<Detail | undefined>(undefined);
  protected readonly detailError = signal(false);
  protected readonly label = label;
  protected readonly timeLabel = timeLabel;
  protected readonly moneyLabel = moneyLabel;
  protected readonly statusLabel = statusLabel;
  protected opener: HTMLElement | undefined;
  private generation = 0;
  private listController?: AbortController;
  private detailController?: AbortController;

  ngOnChanges(changes: SimpleChanges): void {
    if (this.accessDenied()) {
      this.clear();
      this.status.set('access');
      return;
    }
    if (changes['scopeId'] || changes['requesterId'] || changes['accessDenied']) {
      this.clear();
      this.status.set('loading');
      void this.loadPage(null);
    }
  }

  ngOnDestroy(): void { this.clear(); }

  protected refresh(): void {
    if (this.loading()) return;
    this.listController?.abort();
    this.nextCursor.set(null);
    void this.loadPage(null);
  }

  protected loadMore(): void {
    const cursor = this.nextCursor();
    if (!cursor || this.loading()) return;
    void this.loadPage(cursor);
  }

  private async loadPage(cursor: string | null): Promise<void> {
    const controller = new AbortController();
    const generation = this.generation;
    this.listController = controller;
    this.loading.set(true);
    this.error.set(false);
    const scopeId = encodeURIComponent(this.scopeId());
    let url = `/api/memory/${scopeId}/maintenance`;
    if (cursor) url += `?cursor=${encodeURIComponent(cursor)}`;
    const result = await readJson(url, controller.signal);
    if (controller.signal.aborted || generation !== this.generation) return;
    this.loading.set(false);
    if (result.kind === 'access') {
      this.clear();
      this.status.set('access');
      return;
    }
    if (result.kind !== 'ok' || !isPage(result.body)) {
      this.error.set(true);
      return;
    }
    const existing = cursor ? this.rows() : [];
    const seen = new Set(existing.map(function runId(row) { return row.runId; }));
    const newRows: Run[] = [];
    for (const row of result.body.history) {
      if (!seen.has(row.runId)) newRows.push(row);
      seen.add(row.runId);
    }
    this.rows.set([...existing, ...newRows]);
    this.nextCursor.set(result.body.nextCursor);
    this.nextAt.set(result.body.nextAt);
    this.status.set(result.body.status);
  }

  protected open(row: Run, event: Event): void {
    this.detailController?.abort();
    this.opener = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
    this.selected.set(row);
    this.detail.set(undefined);
    this.detailError.set(false);
    void this.readDetail(row.runId);
  }

  protected checkStatus(): void {
    const row = this.selected();
    if (row) void this.readDetail(row.runId);
  }

  private async readDetail(runId: string): Promise<void> {
    this.detailController?.abort();
    const controller = new AbortController();
    this.detailController = controller;
    const generation = this.generation;
    this.detailError.set(false);
    const scopeId = encodeURIComponent(this.scopeId());
    const url = `/api/memory/${scopeId}/maintenance/${encodeURIComponent(runId)}`;
    const result = await readJson(url, controller.signal);
    if (controller.signal.aborted || generation !== this.generation ||
      this.selected()?.runId !== runId) return;
    if (result.kind === 'access') {
      this.clear();
      this.status.set('access');
      return;
    }
    if (result.kind !== 'ok' || !isDetail(result.body) || result.body.runId !== runId) {
      this.detailError.set(true);
      return;
    }
    this.detail.set(result.body);
  }

  protected close(): void {
    this.detailController?.abort();
    this.selected.set(undefined);
    this.detail.set(undefined);
    this.detailError.set(false);
  }

  private clear(): void {
    this.generation += 1;
    this.listController?.abort();
    this.detailController?.abort();
    this.rows.set([]);
    this.nextCursor.set(null);
    this.nextAt.set(null);
    this.selected.set(undefined);
    this.detail.set(undefined);
    this.error.set(false);
    this.detailError.set(false);
    this.loading.set(false);
  }
}
