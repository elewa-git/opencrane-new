import { ChangeDetectionStrategy, Component, input, output, signal, type OnInit } from '@angular/core';
import { auditDetailSchema, auditResponseSchema, type AuditRecord, type AuditRow }
  from '@opencrane/protocol';

type LoadState = 'loading' | 'ready' | 'unavailable' | 'access';

@Component({
  selector: 'oc-audit',
  templateUrl: './audit.html',
  styleUrl: './audit.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuditScreen implements OnInit {
  readonly conversationId = input<string>();
  readonly accessLost = output<void>();
  protected readonly rows = signal<AuditRow[]>([]);
  protected readonly state = signal<LoadState>('loading');
  protected readonly evidenceAt = signal<string | undefined>(undefined);
  protected readonly nextBefore = signal<number | undefined>(undefined);
  protected readonly detail = signal<AuditRecord[]>([]);
  protected readonly detailId = signal<string | undefined>(undefined);
  protected readonly detailBefore = signal<number | undefined>(undefined);
  protected readonly detailState = signal<LoadState>('loading');
  protected family = '';
  protected outcomeFilter = '';
  protected dateRange = 7;
  protected decision = '';
  protected requestId = '';
  protected turnId = '';
  protected reference = '';
  private generation = 0;
  private detailGeneration = 0;
  private opener: HTMLButtonElement | undefined;
  private revoked = false;

  ngOnInit(): void {
    const address = new URLSearchParams(globalThis.location.search);
    const supplied = address.get('reference');
    if (!this.conversationId() && supplied && /^[a-f0-9]{32}$/u.test(supplied)) {
      this.reference = supplied;
    }
    void this.load();
  }

  protected filter(event: Event): void {
    event.preventDefault();
    this.startSelection();
  }

  protected selectFamily(family: string): void {
    this.family = family;
    this.startSelection();
  }

  protected selectOutcome(outcome: string): void {
    this.outcomeFilter = outcome;
    this.startSelection();
  }

  protected selectDate(days: number): void {
    this.dateRange = days;
    this.startSelection();
  }

  protected clearFilters(): void {
    this.family = '';
    this.outcomeFilter = '';
    this.reference = '';
    this.requestId = '';
    this.turnId = '';
    this.decision = '';
    this.startSelection();
  }

  private startSelection(): void {
    this.rows.set([]);
    this.nextBefore.set(undefined);
    this.closeDetail(false);
    void this.load();
  }

  protected async load(before?: number): Promise<void> {
    if (this.revoked) return;
    const generation = ++this.generation;
    if (!this.rows().length) this.state.set('loading');
    const query = this.listQuery(before);
    const conversation = this.conversationId();
    const path = conversation
      ? `/api/conversations/${encodeURIComponent(conversation)}/history`
      : '/api/org/history';
    try {
      const response = await fetch(`${path}?${query.toString()}`);
      if (response.status === 401 || response.status === 403) {
        this.loseAccess();
        return;
      }
      if (!response.ok) throw new Error('History unavailable');
      const raw: unknown = await response.json();
      const result = auditResponseSchema.parse(raw);
      if (generation !== this.generation || this.revoked) return;
      const prior = before === undefined ? [] : this.rows();
      const seen = new Set(prior.map(row => row.id));
      const newRows = result.rows.filter(row => !seen.has(row.id));
      this.rows.set([...prior, ...newRows]);
      this.nextBefore.set(result.nextBefore);
      this.evidenceAt.set(new Date().toISOString());
      this.state.set('ready');
    } catch {
      if (generation === this.generation && !this.revoked) this.state.set('unavailable');
    }
  }

  private listQuery(before?: number): URLSearchParams {
    const query = new URLSearchParams();
    const fields = { decision: this.decision, requestId: this.requestId,
      turnId: this.turnId, reference: this.reference, type: this.family,
      outcome: this.outcomeFilter };
    for (const [key, value] of Object.entries(fields)) {
      if (value.trim()) query.set(key, value.trim());
    }
    if (this.dateRange > 0 && !this.conversationId()) {
      const from = new Date(Date.now() - this.dateRange * 86_400_000);
      query.set('from', from.toISOString());
    }
    if (before !== undefined) query.set('before', String(before));
    return query;
  }

  protected async openDetail(row: AuditRow, button: HTMLButtonElement): Promise<void> {
    if (this.conversationId() || this.revoked) return;
    this.opener = button;
    this.detailId.set(row.id);
    this.detail.set([]);
    this.detailBefore.set(undefined);
    setTimeout(this.focusDetail.bind(this), 0);
    await this.loadDetail(row.id);
  }

  private focusDetail(): void {
    document.querySelector<HTMLButtonElement>('.close-detail')?.focus();
  }

  protected checkStatus(row: AuditRow, button: HTMLButtonElement): void {
    if (this.conversationId()) {
      void this.load();
      return;
    }
    void this.openDetail(row, button);
  }

  protected async loadDetail(id: string, before?: number): Promise<void> {
    const generation = ++this.detailGeneration;
    this.detailState.set('loading');
    const suffix = before === undefined ? '' : `?before=${before}`;
    try {
      const response = await fetch(`/api/org/history/${encodeURIComponent(id)}${suffix}`);
      if (response.status === 401 || response.status === 403) {
        this.loseAccess();
        return;
      }
      if (!response.ok) throw new Error('Detail unavailable');
      const raw: unknown = await response.json();
      const result = auditDetailSchema.parse(raw);
      if (generation !== this.detailGeneration || this.revoked || this.detailId() !== id) return;
      const prior = before === undefined ? [] : this.detail();
      const seen = new Set(prior.map(record => record.eventId));
      const newRecords = result.records.filter(record => !seen.has(record.eventId));
      this.detail.set([...prior, ...newRecords]);
      this.detailBefore.set(result.nextBefore);
      this.detailState.set('ready');
    } catch {
      if (generation === this.detailGeneration && !this.revoked) {
        this.detailState.set('unavailable');
      }
    }
  }

  protected closeDetail(restoreFocus = true): void {
    this.detailGeneration++;
    this.detailId.set(undefined);
    this.detail.set([]);
    this.detailBefore.set(undefined);
    if (restoreFocus) this.opener?.focus();
    this.opener = undefined;
  }

  private loseAccess(): void {
    this.revoked = true;
    this.generation++;
    this.detailGeneration++;
    this.rows.set([]);
    this.nextBefore.set(undefined);
    this.evidenceAt.set(undefined);
    this.closeDetail(false);
    this.state.set('access');
    this.accessLost.emit();
  }

  protected outcome(row: AuditRow): string {
    if (row.outcome === 'unknown') return 'Outcome unknown';
    if (row.outcome === 'not_dispatched') return 'Not dispatched';
    if (row.outcome === 'recorded') return 'Change recorded';
    return row.outcome === 'success' ? 'Confirmed' : 'Failed';
  }

  protected title(row: AuditRow): string {
    const record = row.records[0];
    if (record?.operation) return `Membership and ownership · ${record.operation.replace('_', ' ')}`;
    if (record?.publicationKind) {
      const kind = record.publicationKind === 'interim' ? 'Interim' : 'Final';
      return `${kind} publication`;
    }
    if (record?.delegationAccess) return 'Delegation outcome';
    if (record?.maintenanceAction) return 'Memory maintenance · content restricted';
    return row.requestId ? `Request ${row.requestId}` : 'Organisation change';
  }

  protected safeLink(record: AuditRecord): string | undefined {
    if (this.state() !== 'ready' || this.detailState() === 'unavailable') return undefined;
    if (!record.taskHref) return undefined;
    if (record.type === 'memory.maintenance_recorded') return undefined;
    return record.taskHref;
  }
}
