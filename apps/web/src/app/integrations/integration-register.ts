import {
  ChangeDetectionStrategy, Component, computed, signal, type OnInit, type OnDestroy,
} from '@angular/core';
import { integrationsResponseSchema, type IntegrationRow } from '@opencrane/protocol';
import { SharedState } from '../shared-state/shared-state';
import { GrainLoader } from '../ui/grain-loader';

type Tab = 'all' | 'attention' | 'review';
type LoadState = 'loading' | 'ready' | 'failed' | 'retrying' | 'access';

@Component({
  selector: 'oc-integration-register',
  imports: [SharedState, GrainLoader],
  templateUrl: './integration-register.html',
  styleUrl: './integration-register.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IntegrationRegister implements OnInit, OnDestroy {
  protected readonly tabs: readonly { id: Tab; label: string }[] = [
    { id: 'all', label: 'All' }, { id: 'attention', label: 'Needs attention' },
    { id: 'review', label: 'Pending review' },
  ];
  protected readonly skeletonWidths = ['48%', '65%', '54%', '72%'];
  protected readonly rows = signal<IntegrationRow[]>([]);
  protected readonly selectedTab = signal<Tab>('all');
  protected readonly loadState = signal<LoadState>('loading');
  protected readonly loadedAt = signal<string | undefined>(undefined);
  protected readonly attention = computed(this.attentionRows.bind(this));
  protected readonly reviews = computed(this.reviewRows.bind(this));
  protected readonly visibleRows = computed(this.filteredRows.bind(this));

  private readonly request = new AbortController();

  protected filterCount(tab: Tab): number {
    if (tab === 'attention') {
      return this.attention().length;
    }
    if (tab === 'review') {
      return this.reviews().length;
    }
    return this.rows().length;
  }

  private attentionRows(): IntegrationRow[] {
    return this.rows().filter(needsAttention);
  }

  private reviewRows(): IntegrationRow[] {
    return this.rows().filter(needsReview);
  }

  private filteredRows(): IntegrationRow[] {
    if (this.selectedTab() === 'attention') {
      return this.attention();
    }
    if (this.selectedTab() === 'review') {
      return this.reviews();
    }
    return this.rows();
  }

  ngOnInit(): void {
    void this.load();
  }

  ngOnDestroy(): void {
    // A removed page must not accept protected results from an old read.
    this.request.abort();
  }

  protected select(tab: Tab): void {
    this.selectedTab.set(tab);
  }
  protected refresh(): void {
    if (this.loadState() === 'loading' || this.loadState() === 'retrying') {
      return;
    }
    this.loadState.set('retrying');
    void this.load();
  }
  protected tabKeydown(event: KeyboardEvent): void {
    const tabs = this.tabs.map(tabId);
    const current = tabs.indexOf(this.selectedTab());
    let next = -1;
    if (event.key === 'Home') {
      next = 0;
    }
    if (event.key === 'End') {
      next = tabs.length - 1;
    }
    if (event.key === 'ArrowRight') {
      next = (current + 1) % tabs.length;
    }
    if (event.key === 'ArrowLeft') {
      next = (current + tabs.length - 1) % tabs.length;
    }
    if (next < 0) {
      return;
    }
    event.preventDefault();
    const tab = tabs[next]!;
    this.select(tab);
    globalThis.document.getElementById(`integrations-tab-${tab}`)?.focus();
  }
  protected emptyFilterMessage(): string {
    if (this.selectedTab() === 'attention') {
      return 'No servers need attention';
    }
    return 'No servers are pending review';
  }
  protected tools(row: IntegrationRow): string {
    return row.toolsTotal === null ? '—' : `${row.toolsAllowed} of ${row.toolsTotal}`;
  }
  protected loadedTime(): string {
    const value = this.loadedAt();
    if (!value) {
      return '';
    }
    const options: Intl.DateTimeFormatOptions = {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC',
    };
    return `${new Date(value).toLocaleTimeString('en-GB', options)} UTC`;
  }

  protected tabCount(count: number): string {
    if (this.loadState() === 'loading') {
      return '–';
    }
    return `· ${count}`;
  }

  protected loadMessage(): string {
    const state = this.loadState();
    if (state === 'loading') {
      return 'Loading integrations…';
    }
    if (state === 'access') {
      return 'Integration access changed';
    }
    return 'Integrations loaded';
  }

  private async load(): Promise<void> {
    try {
      const response = await fetch('/api/org/integrations', {
        headers: { accept: 'application/json' }, signal: this.request.signal,
      });
      if (this.request.signal.aborted) {
        return;
      }
      if (response.status === 401 || response.status === 403) {
        this.rows.set([]);
        this.loadedAt.set(undefined);
        this.loadState.set('access');
        return;
      }
      if (!response.ok) {
        throw new Error('read failed');
      }
      const raw: unknown = await response.json();
      if (this.request.signal.aborted) {
        return;
      }
      const result = integrationsResponseSchema.parse(raw);
      this.rows.set(result.rows);
      this.loadedAt.set(result.loadedAt);
      this.loadState.set('ready');
    } catch {
      if (this.request.signal.aborted) {
        return;
      }
      this.loadState.set('failed');
    }
  }
}

function needsAttention(row: IntegrationRow): boolean {
  return ['needs_input', 'failed', 'unknown', 'access_changed'].includes(row.status.kind);
}

function needsReview(row: IntegrationRow): boolean {
  const detail = row.status.detail.toLowerCase();
  return row.status.kind === 'needs_input' && detail.includes('pending review');
}

function tabId(tab: { id: Tab }): Tab {
  return tab.id;
}
