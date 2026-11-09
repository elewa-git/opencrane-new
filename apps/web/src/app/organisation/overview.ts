import { ChangeDetectionStrategy, Component, output, signal, type OnInit } from '@angular/core';

type Priority = 'unknown' | 'needs_input' | 'failure' | 'ready';
type SourceName = 'people' | 'providers' | 'integrations' | 'spending' |
  'memory' | 'publication' | 'routines';
type Action = 'check_status' | 'review_tools' | 'view_invitation_links' | 'view_evidence';

interface OverviewRow {
  id: string;
  source: SourceName;
  priority: Priority;
  eventAt: string | null;
  action: Action;
  href: string;
  affectedPeople?: string;
}

interface OverviewSource {
  name: SourceName;
  status: 'current' | 'applying' | 'unavailable';
  checkedAt: string;
}

interface OverviewReply {
  rows: OverviewRow[];
  next: string | null;
  allClear: boolean;
  sources: OverviewSource[];
}

function isOverviewReply(value: unknown): value is OverviewReply {
  if (value === null || typeof value !== 'object') return false;
  if (!('rows' in value) || !Array.isArray(value.rows)) return false;
  if (!('sources' in value) || !Array.isArray(value.sources)) return false;
  if (!('next' in value) || !(value.next === null || typeof value.next === 'string')) {
    return false;
  }
  return true;
}

const sourceLabels: Record<SourceName, string> = {
  people: 'People & groups',
  providers: 'Model providers',
  integrations: 'Integrations',
  spending: 'Spending',
  memory: 'Memory checks',
  publication: 'Publication',
  routines: 'Routines',
};

const priorityLabels: Record<Priority, string> = {
  unknown: 'Outcome unknown',
  needs_input: 'Needs input',
  failure: 'Needs attention',
  ready: 'Ready',
};

const actionLabels: Record<Action, string> = {
  check_status: 'Check status',
  review_tools: 'Review tools',
  view_invitation_links: 'View links',
  view_evidence: 'View evidence',
};

function validDate(value: string | null | undefined): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function safeReference(value: string): boolean {
  return /^[\w-]{1,200}$/u.test(value);
}

export function overviewDestination(row: OverviewRow): string | undefined {
  if (row.source === 'people' && row.href === '/org/people') return row.href;
  if (row.source === 'providers') return '/org/models';
  if (row.source === 'integrations' &&
      /^\/org\/integrations\/[\w-]{1,200}$/u.test(row.href)) return row.href;
  if (row.source === 'spending' && row.href.startsWith('/api/org/effects/')) {
    const reference = row.href.slice('/api/org/effects/'.length);
    if (safeReference(reference)) return `/org/spending?effect=${encodeURIComponent(reference)}`;
  }
  if (row.source === 'memory' && row.href.startsWith('/api/org/history/')) {
    const reference = row.href.slice('/api/org/history/'.length);
    if (/^[a-f0-9]{32}$/u.test(reference)) {
      return `/org/history?reference=${encodeURIComponent(reference)}`;
    }
  }
  return undefined;
}

function rowKey(row: OverviewRow): string {
  return `${row.source}:${row.id}`;
}

function isCurrent(source: OverviewSource): boolean {
  return source.status === 'current';
}

function isUnavailable(source: OverviewSource): boolean {
  return source.status === 'unavailable';
}

function sourceTime(source: OverviewSource): string {
  return source.checkedAt;
}

@Component({
  selector: 'oc-overview',
  templateUrl: './overview.html',
  styleUrl: './overview.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OverviewScreen implements OnInit {
  readonly accessLost = output<void>();
  protected readonly rows = signal<OverviewRow[]>([]);
  protected readonly sources = signal<OverviewSource[]>([]);
  protected readonly next = signal<string | null>(null);
  protected readonly loadedAt = signal<string | null>(null);
  protected readonly state = signal<'loading' | 'ready' | 'stale' | 'access'>('loading');
  protected readonly sourceLabels = sourceLabels;
  protected readonly priorityLabels = priorityLabels;
  protected readonly actionLabels = actionLabels;
  protected readonly destination = overviewDestination;
  private loading = false;
  private revoked = false;
  private generation = 0;

  ngOnInit(): void {
    void this.refresh();
  }

  protected readableTime(value: string | null): string {
    if (!validDate(value)) return 'Time not available';
    return new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short',
      timeZone: 'UTC' }) + ' UTC';
  }

  protected checkedAt(): string | null {
    const current = this.sources().filter(isCurrent);
    if (current.length !== this.sources().length || current.length === 0) return null;
    return this.sourceCheckedAt();
  }

  protected sourceCheckedAt(): string | null {
    const current = this.sources().filter(isCurrent);
    const times = current.map(sourceTime);
    if (times.length === 0 || !times.every(validDate)) return null;
    times.sort();
    return times[0] ?? null;
  }

  protected allClear(): boolean {
    return this.rows().length === 0 && this.next() === null && this.checkedAt() !== null;
  }

  protected unavailableSources(): OverviewSource[] {
    return this.sources().filter(isUnavailable);
  }

  protected rowTitle(row: OverviewRow): string {
    if (row.source === 'people') return 'Invitation needs attention';
    if (row.source === 'providers') return 'Model provider check';
    if (row.source === 'integrations') return 'Integration tools need review';
    if (row.source === 'spending') return 'Spending effect needs checking';
    if (row.source === 'memory') return 'Memory check needs attention';
    return `${sourceLabels[row.source]} needs attention`;
  }

  protected async refresh(): Promise<void> {
    if (this.loading || this.revoked) return;
    this.next.set(null);
    await this.loadPage(undefined, false);
  }

  protected async more(): Promise<void> {
    const cursor = this.next();
    if (!cursor || this.loading || this.revoked) return;
    await this.loadPage(cursor, true);
  }

  private clearAccess(): void {
    // Keep a refusal final, so a late successful reply cannot restore protected rows.
    this.revoked = true;
    this.generation += 1;
    this.rows.set([]);
    this.sources.set([]);
    this.next.set(null);
    this.loadedAt.set(null);
    this.state.set('access');
    this.accessLost.emit();
  }

  private acceptPage(page: OverviewReply, append: boolean): void {
    if (append) {
      const seen = new Set(this.rows().map(rowKey));
      const unique: OverviewRow[] = [];
      for (const row of page.rows) {
        if (!seen.has(rowKey(row))) unique.push(row);
      }
      this.rows.set([...this.rows(), ...unique]);
    } else {
      this.rows.set(page.rows);
    }
    this.sources.set(page.sources);
    this.next.set(page.next);
    this.loadedAt.set(new Date().toISOString());
    this.state.set('ready');
  }

  private async loadPage(cursor: string | undefined, append: boolean): Promise<void> {
    this.loading = true;
    const generation = ++this.generation;
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    try {
      const response = await fetch(`/api/org/overview${query}`);
      if (response.status === 401 || response.status === 403) {
        this.clearAccess();
        return;
      }
      if (response.status === 400 && cursor) {
        // A changed source invalidates the saved cursor. Restart once at page one.
        this.loading = false;
        this.next.set(null);
        await this.loadPage(undefined, false);
        return;
      }
      if (!response.ok) throw new Error('Overview unavailable');
      const page: unknown = await response.json();
      if (this.revoked || generation !== this.generation) return;
      if (!isOverviewReply(page)) {
        throw new Error('Invalid overview response');
      }
      this.acceptPage(page, append);
    } catch {
      if (!this.revoked && generation === this.generation) this.state.set('stale');
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }
}
