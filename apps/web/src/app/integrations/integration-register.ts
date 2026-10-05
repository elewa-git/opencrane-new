import {
  ChangeDetectionStrategy, Component, computed, signal, type OnDestroy, type OnInit,
} from '@angular/core';
import { integrationsResponseSchema, type IntegrationRow } from '@opencrane/protocol';
import { SharedState } from '../shared-state/shared-state';
import { GrainLoader } from '../ui/grain-loader';
import { IntegrationsAccessLost } from './integrations-access-lost';
import { needsAttention, needsReview } from './integration-status';

type Tab = 'all' | 'attention' | 'review';
type LoadState = 'loading' | 'ready' | 'failed' | 'retrying' | 'access';

@Component({
  selector: 'oc-integration-register',
  imports: [SharedState, GrainLoader, IntegrationsAccessLost],
  templateUrl: './integration-register.html',
  styleUrl: './integration-register.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IntegrationRegister implements OnInit, OnDestroy {
  protected readonly tabs: readonly { id: Tab; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'attention', label: 'Needs attention' },
    { id: 'review', label: 'Pending review' },
  ];
  protected readonly skeletonWidths = ['48%', '65%', '54%', '72%'];
  protected readonly rows = signal<IntegrationRow[]>([]);
  protected readonly selectedTab = signal<Tab>('all');
  protected readonly loadState = signal<LoadState>('loading');
  protected readonly loadedAt = signal<string | undefined>(undefined);
  protected readonly search = signal('');
  protected readonly hasShownProtectedContent = signal(false);
  protected readonly needsReview = needsReview;
  protected readonly attention = computed(this.attentionRows.bind(this));
  protected readonly reviews = computed(this.reviewRows.bind(this));
  protected readonly tabRows = computed(this.selectedRows.bind(this));
  protected readonly visibleRows = computed(this.filteredRows.bind(this));
  protected readonly announcement = computed(this.announcementText.bind(this));

  private readonly request = new AbortController();

  protected filterCount(tab: Tab): number {
    if (tab === 'attention') return this.attention().length;
    if (tab === 'review') return this.reviews().length;
    return this.rows().length;
  }

  private attentionRows(): IntegrationRow[] {
    return this.rows().filter(needsAttention);
  }

  private reviewRows(): IntegrationRow[] {
    return this.rows().filter(needsReview);
  }

  private selectedRows(): IntegrationRow[] {
    if (this.selectedTab() === 'attention') return this.attention();
    if (this.selectedTab() === 'review') return this.reviews();
    return this.rows();
  }

  private filteredRows(): IntegrationRow[] {
    const query = this.search().trim().toLocaleLowerCase('en-GB');
    if (!query) return this.tabRows();
    const matchingRows: IntegrationRow[] = [];
    for (const row of this.tabRows()) {
      if (this.rowMatches(row, query)) matchingRows.push(row);
    }
    return matchingRows;
  }

  private rowMatches(row: IntegrationRow, query: string): boolean {
    const searchableText = [row.name, row.source.label, row.source.detail];
    for (const value of searchableText) {
      if (value.toLocaleLowerCase('en-GB').includes(query)) return true;
    }
    return false;
  }

  private announcementText(): string {
    if (this.loadState() === 'loading') return 'Loading integrations…';
    const count = this.visibleRows().length;
    if (this.selectedTab() === 'attention') {
      return count === 1 ? '1 integration needs attention' : `${count} integrations need attention`;
    }
    if (this.selectedTab() === 'review') {
      return count === 1 ? '1 integration pending review' : `${count} integrations pending review`;
    }
    return `${count} integrations`;
  }

  ngOnInit(): void {
    void this.load();
  }

  ngOnDestroy(): void {
    this.request.abort();
  }

  protected select(tab: Tab): void {
    this.selectedTab.set(tab);
  }

  protected searchChanged(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    this.search.set(input.value);
  }

  protected refresh(): void {
    if (this.loadState() === 'loading' || this.loadState() === 'retrying') return;
    this.loadState.set('retrying');
    void this.load();
  }

  protected tabKeydown(event: KeyboardEvent): void {
    const tabIds = this.tabs.map(tabId);
    const currentIndex = tabIds.indexOf(this.selectedTab());
    let nextIndex = -1;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabIds.length - 1;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabIds.length;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex + tabIds.length - 1) % tabIds.length;
    if (nextIndex < 0) return;
    event.preventDefault();
    const nextTab = tabIds[nextIndex];
    if (!nextTab) return;
    this.select(nextTab);
    globalThis.document.getElementById(`integrations-tab-${nextTab}`)?.focus();
  }

  protected clearSearch(): void {
    this.search.set('');
  }

  protected tools(row: IntegrationRow): string {
    if (row.toolsTotal === null) return 'Not read yet';
    return `${row.toolsAllowed} of ${row.toolsTotal} on Allow or Ask`;
  }

  protected loadedTime(): string {
    const value = this.loadedAt();
    if (!value) return '';
    const options: Intl.DateTimeFormatOptions = {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC',
    };
    return `${new Date(value).toLocaleTimeString('en-GB', options)} UTC`;
  }

  protected tabCount(count: number): string {
    if (this.loadState() === 'loading') return '–';
    return `· ${count}`;
  }

  private async load(): Promise<void> {
    try {
      const response = await fetch('/api/org/integrations', {
        headers: { accept: 'application/json' }, signal: this.request.signal,
      });
      if (this.request.signal.aborted) return;
      if (response.status === 401 || response.status === 403) {
        this.clearProtectedContent();
        this.loadState.set('access');
        this.focusAccessHeading();
        return;
      }
      if (!response.ok) throw new Error('read failed');
      const raw: unknown = await response.json();
      if (this.request.signal.aborted) return;
      const result = integrationsResponseSchema.parse(raw);
      this.rows.set(result.rows);
      this.loadedAt.set(result.loadedAt);
      this.loadState.set('ready');
      this.hasShownProtectedContent.set(true);
    } catch {
      if (this.request.signal.aborted) return;
      this.loadState.set('failed');
    }
  }

  private clearProtectedContent(): void {
    this.rows.set([]);
    this.loadedAt.set(undefined);
    this.search.set('');
  }

  private focusAccessHeading(): void {
    if (!this.hasShownProtectedContent()) return;
    requestAnimationFrame(focusAccessHeading);
  }
}

function tabId(tab: { id: Tab }): Tab {
  return tab.id;
}

function focusAccessHeading(): void {
  globalThis.document.getElementById('integration-access-heading')?.focus();
}
