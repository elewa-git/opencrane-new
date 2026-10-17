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
import { compareToolCatalogues } from './tool-changes';
import { reviewCommand } from './review-command';

type DetailState = 'loading' | 'ready' | 'failed' | 'not-found' | 'access';
type ChangeState = 'loading' | 'disabled' | 'reviewing' | 'publishing' | 'applying'
  | 'unknown-review' | 'unknown-publication' | 'conflict' | 'failed' | 'confirmed';

@Component({
  selector: 'oc-integration-detail',
  imports: [SharedState, GrainLoader, IntegrationsAccessLost, IntegrationFacts],
  templateUrl: './integration-detail.html',
  styleUrl: './integration-detail.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IntegrationDetail implements OnInit, OnDestroy {
  readonly serverId = input.required<string>();
  readonly view = input<'detail' | 'changes'>('detail');
  protected readonly row = signal<IntegrationRow | undefined>(undefined);
  protected readonly policy = signal<ToolPolicy | undefined>(undefined);
  protected readonly loadedAt = signal('');
  protected readonly state = signal<DetailState>('loading');
  protected readonly toolsReadState = signal<ToolsReadState>('loading');
  protected readonly refreshing = signal(false);
  protected readonly showRefresh = signal(false);
  protected readonly hasRenderedProtectedContent = signal(false);
  protected readonly facts = computed(this.integrationFacts.bind(this));
  protected readonly comparison = computed(this.toolComparison.bind(this));
  protected readonly changeState = signal<ChangeState>('loading');
  protected readonly changeRef = signal('');
  protected readonly needsReview = needsReview;
  protected readonly skeletonWidths = ['78%', '52%', '66%', '44%'];

  private readonly request = new AbortController();
  private accessLost = false;
  private publicationCommandId = '';

  ngOnInit(): void {
    void this.load();
  }

  ngOnDestroy(): void {
    // Stop both reads so a removed page cannot use protected data from an old reply.
    this.request.abort();
  }

  protected refresh(): void {
    if (this.refreshing() || this.state() === 'loading' || this.accessLost) return;
    if (this.changeState() === 'reviewing') return;
    if (this.publicationCommandId) {
      void this.checkPublicationChange();
      return;
    }
    this.refreshing.set(true);
    this.toolsReadState.set('loading');
    this.changeState.set('loading');
    void this.load();
  }

  protected canReviewChanges(): boolean {
    const policy = this.policy();
    return this.view() === 'changes' && this.toolsReadState() === 'loaded' &&
      this.changeState() === 'disabled' && policy?.driftHeld === true &&
      policy.connectionId !== null && policy.accountMode !== null &&
      policy.catalogue?.tools !== undefined && !this.checkExpired();
  }

  protected changeMessage(): string {
    const state = this.changeState();
    if (state === 'reviewing') return 'Saving the exact tool review…';
    if (state === 'publishing' || state === 'applying') {
      return 'Publishing the reviewed tool list. Calls stay paused until this finishes.';
    }
    if (state === 'unknown-publication') {
      return 'Publication is uncertain. Calls stay paused. Check the original change status.';
    }
    if (state === 'unknown-review') {
      return 'The review outcome is unknown. Read the tool details again before another review.';
    }
    if (state === 'conflict') return 'The tool list changed. Review again after a fresh read.';
    if (state === 'failed') return "Couldn't check publication progress. Calls stay paused.";
    if (state === 'confirmed') return 'The current publication is confirmed.';
    return '';
  }

  protected async reviewAndPublish(): Promise<void> {
    const policy = this.policy();
    if (!policy || !this.canReviewChanges()) return;
    this.changeState.set('reviewing');
    const reviewId = globalThis.crypto.randomUUID();
    try {
      const body = await reviewCommand(policy, reviewId);
      if (this.shouldIgnoreResult()) return;
      const response = await this.sendChange('review', body);
      if (!response || this.shouldIgnoreResult()) return;
      if (response.status === 409) {
        this.changeState.set('conflict');
        return;
      }
      if (!response.ok) {
        this.changeState.set('unknown-review');
        return;
      }
      const receipt: unknown = await response.json();
      if (this.shouldIgnoreResult()) return;
      const sequence = savedSequence(receipt);
      if (sequence === null) {
        this.changeState.set('unknown-review');
        return;
      }
      await this.publish(sequence);
    } catch {
      if (!this.shouldIgnoreResult()) this.changeState.set('unknown-review');
    }
  }

  private async publish(reviewRevision: number): Promise<void> {
    const commandId = globalThis.crypto.randomUUID();
    this.publicationCommandId = commandId;
    this.changeRef.set(commandId);
    this.changeState.set('publishing');
    const body = { commandId, expectedSequence: reviewRevision, reviewRevision };
    try {
      const response = await this.sendChange('publication', body);
      if (!response || this.shouldIgnoreResult()) return;
      if (response.status === 409) {
        this.publicationCommandId = '';
        this.changeRef.set('');
        this.changeState.set('conflict');
        return;
      }
      if (!response.ok) {
        this.changeState.set('unknown-publication');
        return;
      }
      const receipt: unknown = await response.json();
      if (this.shouldIgnoreResult()) return;
      if (savedSequence(receipt) === null) {
        this.changeState.set('unknown-publication');
        return;
      }
      await this.checkPublicationChange();
    } catch {
      if (!this.shouldIgnoreResult()) this.changeState.set('unknown-publication');
    }
  }

  private async sendChange(path: string, body: unknown): Promise<Response | undefined> {
    const url = `/api/org/integrations/${encodeURIComponent(this.serverId())}/${path}`;
    const response = await fetch(url, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: this.request.signal });
    if (this.shouldIgnoreResult() || this.isAccessRefusal(response)) return undefined;
    return response;
  }

  protected async checkPublicationChange(): Promise<void> {
    if (!this.publicationCommandId || this.accessLost) return;
    const originalId = this.publicationCommandId;
    const url = `/api/org/integrations/changes/${encodeURIComponent(originalId)}`;
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' },
        signal: this.request.signal });
      if (this.shouldIgnoreResult() || this.isAccessRefusal(response)) return;
      if (!response.ok) throw new Error('Change status unavailable');
      const status: unknown = await response.json();
      if (this.shouldIgnoreResult() || this.publicationCommandId !== originalId) return;
      this.setPublicationState(status, originalId);
    } catch {
      if (!this.shouldIgnoreResult()) this.changeState.set('unknown-publication');
    }
  }

  private setPublicationState(raw: unknown, originalId: string): void {
    if (!isRecord(raw)) {
      this.changeState.set('unknown-publication');
      return;
    }
    if (raw['changeRef'] !== originalId) {
      this.changeState.set('unknown-publication');
      return;
    }
    if (raw['status'] === 'ready') {
      this.changeState.set('confirmed');
      return;
    }
    if (raw['status'] === 'applying') {
      this.changeState.set('applying');
      return;
    }
    this.changeState.set('unknown-publication');
  }

  protected announcementText(): string {
    if (this.refreshing()) return 'Refreshing integration…';
    if (this.state() === 'loading') return 'Loading integration…';
    if (this.state() === 'failed' && this.row()) {
      return "Couldn't load this integration. The details below are from the last successful read.";
    }
    if (this.state() === 'failed') return "Couldn't load this integration.";
    if (this.toolsReadState() === 'failed' || this.toolsReadState() === 'list-failed') {
      return "Couldn't check the tool policy.";
    }
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

  protected driftHeld(): boolean {
    return this.policy()?.driftHeld === true;
  }

  protected driftSummary(): string {
    const counts = this.comparison()?.counts;
    if (!counts) return "The earlier list isn't saved, so review every tool.";
    return `Found ${counts.added} added, ${counts.removed} removed and ${counts.changed} changed`;
  }

  protected checkExpired(): boolean {
    const policy = this.policy();
    if (!policy?.catalogue) return false;
    return policy.expiresAt === null || Date.parse(policy.expiresAt) <= Date.now();
  }

  protected checkedTime(): string {
    const checkedAt = this.policy()?.catalogue?.checkedAt ?? this.policy()?.checkedAt;
    if (!checkedAt) return 'unknown';
    return new Date(checkedAt).toLocaleString('en-GB', { dateStyle: 'medium',
      timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
  }

  private toolComparison() {
    const policy = this.policy();
    return policy ? compareToolCatalogues(policy) : null;
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
      this.state.set('ready');
      this.hasRenderedProtectedContent.set(true);
      this.focusHeaderRefreshAfterMessageRetry();
      await this.loadToolPolicy();
    } catch {
      if (this.shouldIgnoreResult()) return;
      this.state.set('failed');
      this.toolsReadState.set(this.row() ? 'list-failed' : 'failed');
      this.refreshing.set(false);
      this.showRefresh.set(true);
    }
  }

  private async loadToolPolicy(): Promise<void> {
    try {
      const toolsResponse = await fetch(this.toolsUrl(), {
        headers: { accept: 'application/json' }, signal: this.request.signal,
      });
      if (this.shouldIgnoreResult() || this.isAccessRefusal(toolsResponse)) return;
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
      if (this.view() === 'changes' && !this.publicationCommandId) {
        await this.readPublicationStatus();
      }
    } catch {
      if (!this.shouldIgnoreResult()) this.markToolsReadFailed();
    }
  }

  private markToolsReadFailed(): void {
    this.toolsReadState.set('failed');
    this.state.set('ready');
    this.refreshing.set(false);
    this.showRefresh.set(true);
    this.hasRenderedProtectedContent.set(true);
  }

  private async readPublicationStatus(): Promise<void> {
    const url = `/api/org/integrations/${encodeURIComponent(this.serverId())}/publication`;
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' },
        signal: this.request.signal });
      if (this.shouldIgnoreResult() || this.isAccessRefusal(response)) return;
      if (!response.ok) throw new Error('Publication status unavailable');
      const status: unknown = await response.json();
      if (this.shouldIgnoreResult()) return;
      if (!isRecord(status)) throw new Error('Invalid publication status');
      if (status['status'] === 'disabled') {
        this.changeState.set('disabled');
      } else if (status['status'] === 'ready') {
        this.changeState.set('confirmed');
      } else if (status['status'] === 'applying' && typeof status['changeRef'] === 'string') {
        this.publicationCommandId = status['changeRef'];
        this.changeRef.set(status['changeRef']);
        this.changeState.set('applying');
      } else {
        this.changeState.set('failed');
      }
    } catch {
      if (!this.shouldIgnoreResult()) this.changeState.set('failed');
    }
  }

  private toolsUrl(): string {
    return `/api/org/integrations/${encodeURIComponent(this.serverId())}/tools`;
  }

  private shouldIgnoreResult(): boolean {
    return this.accessLost || this.request.signal.aborted;
  }

  // Keep this public so the test can check a reply after access has ended.
  isAccessRefusal(response: Response): boolean {
    if (response.status !== 401 && response.status !== 403) return false;
    this.accessLost = true;
    this.request.abort();
    this.row.set(undefined);
    this.policy.set(undefined);
    this.changeState.set('loading');
    this.changeRef.set('');
    this.publicationCommandId = '';
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

  private focusHeaderRefreshAfterMessageRetry(): void {
    if (!this.refreshing()) return;
    requestAnimationFrame(focusHeaderRefresh);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function savedSequence(value: unknown): number | null {
  if (!isRecord(value) || value['status'] !== 'appended') return null;
  const sequence = value['sequence'];
  return typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence > 0
    ? sequence : null;
}

function focusAccessHeading(): void {
  globalThis.document.getElementById('integration-access-heading')?.focus();
}

function focusHeaderRefresh(): void {
  globalThis.document.getElementById('integration-refresh')?.focus();
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
