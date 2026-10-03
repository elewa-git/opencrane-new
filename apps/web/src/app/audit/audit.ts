import { ChangeDetectionStrategy, Component, input, signal, type OnInit } from '@angular/core';
import { auditResponseSchema, type AuditRow } from '@opencrane/protocol';
import { SharedState } from '../shared-state/shared-state';

@Component({ selector: 'oc-audit', imports: [SharedState], templateUrl: './audit.html', styleUrl: './audit.css', changeDetection: ChangeDetectionStrategy.OnPush })
export class AuditScreen implements OnInit {
  readonly conversationId = input<string>();
  protected readonly rows = signal<AuditRow[]>([]);
  protected readonly state = signal<'loading' | 'ready' | 'unavailable' | 'access'>('loading');
  protected readonly nextBefore = signal<number | undefined>(undefined);
  protected decision = '';
  protected requestId = '';
  protected turnId = '';
  private pending = false;
  ngOnInit() { void this.load(); }
  protected filter(event: Event) { event.preventDefault(); void this.load(); }
  protected outcome(row: AuditRow) {
    return row.outcome === 'unknown' ? 'Outcome unknown' : row.outcome === 'not_dispatched' ? 'Not dispatched'
      : row.outcome === 'recorded' ? 'Change recorded' : row.outcome === 'success' ? 'Success' : 'Error';
  }
  protected async load(before?: number) {
    if (this.pending) return;
    this.pending = true; this.state.set('loading'); this.rows.set([]); this.nextBefore.set(undefined);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries({ decision: this.decision, requestId: this.requestId, turnId: this.turnId })) {
      if (value.trim()) query.set(key, value.trim());
    }
    if (before !== undefined) query.set('before', String(before));
    const conversation = this.conversationId();
    const path = conversation ? `/api/conversations/${encodeURIComponent(conversation)}/history` : '/api/org/history';
    try {
      const response = await fetch(`${path}${query.size ? `?${query.toString()}` : ''}`);
      if ([401, 403].includes(response.status)) { this.state.set('access'); return; }
      if (!response.ok) throw new Error('History unavailable');
      const raw: unknown = await response.json();
      const result = auditResponseSchema.parse(raw);
      this.rows.set(result.rows); this.nextBefore.set(result.nextBefore); this.state.set('ready');
    } catch { this.state.set('unavailable'); }
    finally { this.pending = false; }
  }
}
