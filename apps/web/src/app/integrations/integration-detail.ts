import {
  ChangeDetectionStrategy, Component, computed, input, signal,
  type OnDestroy, type OnInit,
} from '@angular/core';
import {
  integrationsResponseSchema, toolPolicySchema,
  type IntegrationRow, type ToolPolicy,
} from '@opencrane/protocol';
import { SharedState } from '../shared-state/shared-state';
import { GrainLoader } from '../ui/grain-loader';
import { IntegrationsAccessLost } from './integrations-access-lost';
import { IntegrationFacts } from './integration-facts';
import { buildIntegrationFacts, type ToolsReadState } from './integration-facts-map';
import { needsReview } from './integration-status';

type DetailState = 'loading' | 'ready' | 'failed' | 'not-found' | 'access';

@Component({
  selector: 'oc-integration-detail',
  imports: [SharedState, GrainLoader, IntegrationsAccessLost, IntegrationFacts],
  templateUrl: './integration-detail.html',
  styleUrl: './integration-detail.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IntegrationDetail implements OnInit, OnDestroy {
  readonly serverId = input.required<string>();
  protected readonly row = signal<IntegrationRow | undefined>(undefined);
  protected readonly policy = signal<ToolPolicy | undefined>(undefined);
  protected readonly loadedAt = signal('');
  protected readonly state = signal<DetailState>('loading');
  protected readonly toolsReadState = signal<ToolsReadState>('loading');
  protected readonly refreshing = signal(false);
  protected readonly showRefresh = signal(false);
  protected readonly hasRenderedProtectedContent = signal(false);
  protected readonly facts = computed(this.integrationFacts.bind(this));
  protected readonly needsReview = needsReview;
  protected readonly skeletonWidths = ['78%', '52%', '66%', '44%'];

  private readonly request = new AbortController();
  private accessLost = false;

  ngOnInit(): void {
    void this.load();
  }

  ngOnDestroy(): void {
    // Abort both reads so a removed page cannot accept protected data from an old reply.
    this.request.abort();
  }

  protected refresh(): void {
    if (this.refreshing() || this.state() === 'loading' || this.accessLost) return;
    this.refreshing.set(true);
    this.toolsReadState.set('loading');
    this.policy.set(undefined);
    void this.load();
  }

  protected announcementText(): string {
    if (this.refreshing()) return 'Refreshing integration…';
    if (this.state() === 'loading') return 'Loading integration…';
    if (this.state() === 'failed') return "Couldn't load this integration.";
    if (this.toolsReadState() === 'failed') return "Couldn't check the tool policy.";
    if (this.state() === 'access') return 'You no longer have access to Integrations.';
    if (this.state() === 'not-found') return 'Integration not found.';
    if (this.toolsReadState() === 'loaded') return 'Integration details loaded.';
    return '';
  }

  protected toolsReviewedCount(): number {
    const policy = this.policy();
    if (!policy) return 0;
    let count = 0;
    for (const tool of policy.tools) {
      if (tool.reviewed) count += 1;
    }
    return count;
  }

  protected reviewDetail(): string {
    const policy = this.policy();
    if (!policy) return 'Nothing is available to an assistant yet.';
    const count = this.toolsReviewedCount();
    const total = policy.tools.length;
    const noun = total === 1 ? 'tool' : 'tools';
    return `Nothing is available to an assistant yet. ${count} of ${total} ${noun} reviewed.`;
  }

  protected loadedTime(): string {
    const value = this.loadedAt();
    if (!value) return '';
    const options: Intl.DateTimeFormatOptions = {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC',
    };
    return `${new Date(value).toLocaleTimeString('en-GB', options)} UTC`;
  }

  private integrationFacts() {
    const row = this.row();
    if (!row) return [];
    return buildIntegrationFacts(row, this.policy(), this.toolsReadState(), this.loadedAt());
  }

  private async load(): Promise<void> {
    try {
      const listResponse = await fetch('/api/org/integrations', {
        headers: { accept: 'application/json' }, signal: this.request.signal,
      });
      if (this.shouldIgnoreResult()) return;
      if (this.isAccessRefusal(listResponse)) return;
      if (!listResponse.ok) throw new Error('register read failed');
      const listRaw: unknown = await listResponse.json();
      if (this.shouldIgnoreResult()) return;
      const integrations = integrationsResponseSchema.parse(listRaw);
      const row = findIntegrationRow(integrations.rows, this.serverId());
      if (!row) {
        this.row.set(undefined);
        this.policy.set(undefined);
        this.state.set('not-found');
        this.refreshing.set(false);
        return;
      }
      this.row.set(row);
      this.loadedAt.set(integrations.loadedAt);
      try {
        const toolsResponse = await fetch(this.toolsUrl(), {
          headers: { accept: 'application/json' }, signal: this.request.signal,
        });
        if (this.shouldIgnoreResult()) return;
        if (this.isAccessRefusal(toolsResponse)) return;
        if (!toolsResponse.ok) {
          this.markToolsReadFailed();
          return;
        }
        const toolsRaw: unknown = await toolsResponse.json();
        if (this.shouldIgnoreResult()) return;
        const policy = toolPolicySchema.parse(toolsRaw);
        this.policy.set(policy);
        this.toolsReadState.set('loaded');
        this.state.set('ready');
        this.refreshing.set(false);
        this.hasRenderedProtectedContent.set(true);
      } catch {
        if (this.shouldIgnoreResult()) return;
        this.markToolsReadFailed();
      }
    } catch {
      if (this.shouldIgnoreResult()) return;
      this.state.set('failed');
      this.toolsReadState.set('failed');
      this.refreshing.set(false);
      this.showRefresh.set(true);
    }
  }

  private markToolsReadFailed(): void {
    this.toolsReadState.set('failed');
    this.state.set('ready');
    this.refreshing.set(false);
    this.showRefresh.set(true);
    this.hasRenderedProtectedContent.set(true);
  }

  private toolsUrl(): string {
    return `/api/org/integrations/${encodeURIComponent(this.serverId())}/tools`;
  }

  private shouldIgnoreResult(): boolean {
    return this.accessLost || this.request.signal.aborted;
  }

  isAccessRefusal(response: Response): boolean {
    if (response.status !== 401 && response.status !== 403) return false;
    this.accessLost = true;
    this.request.abort();
    this.row.set(undefined);
    this.policy.set(undefined);
    this.loadedAt.set('');
    this.toolsReadState.set('loading');
    this.refreshing.set(false);
    this.state.set('access');
    this.focusAccessHeading();
    return true;
  }

  private focusAccessHeading(): void {
    if (!this.hasRenderedProtectedContent()) return;
    requestAnimationFrame(focusAccessHeading);
  }
}

function focusAccessHeading(): void {
  globalThis.document.getElementById('integration-access-heading')?.focus();
}

function findIntegrationRow(
  rows: readonly IntegrationRow[],
  serverId: string,
): IntegrationRow | undefined {
  for (const row of rows) {
    if (row.serverId === serverId) return row;
  }
  return undefined;
}
