import { ChangeDetectionStrategy, Component, type OnInit, computed, inject, signal } from '@angular/core';
import { integrationsRefusalSchema, integrationsResponseSchema, logoutResponseSchema, type IntegrationRow, type SharedStateKind } from '@opencrane/protocol';
import { NAVIGATE } from './core/navigate';
import { WebSocketService } from './core/websocket.service';
import { SharedState } from './shared-state/shared-state';

type Tab = 'all' | 'attention' | 'review';
type LoadState = 'loading' | 'ready' | 'failed' | 'retrying' | 'access';

const STATE_EXAMPLES: ReadonlyArray<{ kind: SharedStateKind; name: string; message: string; need: string; action?: string; safe?: boolean }> = [
  { kind: 'not_configured', name: 'Not configured', message: 'Nothing set up yet', need: 'What is missing and who can do it', action: 'Start setup' },
  { kind: 'draft', name: 'Draft', message: 'Steps 1–2 of 4 saved', need: 'What is saved and what is only on this device', action: 'Continue' },
  { kind: 'checking', name: 'Applying / checking', message: 'Reaching OpenAI…', need: 'Which step is underway' },
  { kind: 'needs_input', name: 'Needs input', message: 'Connect your Odoo account', need: 'The exact credential, consent or choice missing', action: 'Connect account' },
  { kind: 'ready', name: 'Ready', message: 'Verified today at 08:40', need: 'Scope and the last successful check', action: 'Use · Test · Manage' },
  { kind: 'failed', name: 'Failed — safe to retry', message: "Couldn't reach OpenAI. Nothing changed.", need: 'The reason, and whether anything changed', safe: true },
  { kind: 'unknown', name: 'Outcome unknown', message: "We couldn't confirm the change", need: "That the system can't confirm the effect yet" },
  { kind: 'access_changed', name: 'Access changed', message: 'You no longer have permission', need: 'Protected details cleared; the next legitimate step', action: 'Ask an admin' },
  { kind: 'disabled', name: 'Disabled / removed', message: 'Removed 12 Sep · history kept', need: 'What stopped and what history remains', action: 'Set up again' },
];

@Component({
  selector: 'app-root', imports: [SharedState], templateUrl: './app.html', styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit {
  private readonly ws = inject(WebSocketService);
  private readonly navigate = inject(NAVIGATE);
  protected readonly orgPage = globalThis.location.pathname.startsWith('/org');
  protected readonly statesPage = globalThis.location.pathname.endsWith('/states');
  protected readonly examples = STATE_EXAMPLES;
  protected readonly rows = signal<IntegrationRow[]>([]);
  protected readonly selectedTab = signal<Tab>('all');
  protected readonly loadState = signal<LoadState>('loading');
  protected readonly loadedAt = signal<string | undefined>(undefined);
  protected readonly addUnavailable = signal(false);
  protected readonly menuOpen = signal(false);
  protected readonly signOutPending = signal(false);
  protected readonly signOutError = signal<string | undefined>(undefined);
  protected readonly attention = computed(() => this.rows().filter((row) =>
    ['needs_input', 'failed', 'unknown', 'access_changed'].includes(row.status.kind)));
  protected readonly reviews = computed(() => this.rows().filter((row) =>
    row.status.kind === 'needs_input' && row.status.detail.toLowerCase().includes('pending review')));
  protected readonly visibleRows = computed(() => this.selectedTab() === 'all' ? this.rows()
    : this.selectedTab() === 'attention' ? this.attention() : this.reviews());

  ngOnInit(): void {
    this.ws.connect();
    if (this.orgPage && !this.statesPage) void this.load();
  }

  protected signIn(): void { this.navigate('/auth/login'); }
  protected async signOut(): Promise<void> {
    this.signOutPending.set(true);
    this.signOutError.set(undefined);
    try {
      const response = await fetch('/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error(`sign out failed with status ${response.status}`);
      const body: unknown = await response.json().catch(() => null);
      const result = logoutResponseSchema.safeParse(body);
      this.navigate(result.success && result.data.endSessionUrl !== null ? result.data.endSessionUrl : '/');
    } catch (error) {
      this.signOutError.set(error instanceof Error ? error.message : 'sign out failed');
    } finally { this.signOutPending.set(false); }
  }
  protected select(tab: Tab): void { this.selectedTab.set(tab); }
  refresh(): void { this.loadState.set('retrying'); void this.load(); }
  protected tools(row: IntegrationRow): string {
    return row.toolsTotal === null ? '—' : `${row.toolsAllowed} of ${row.toolsTotal}`;
  }
  protected rowAction(row: IntegrationRow): string | undefined {
    if (row.status.kind === 'ready') return 'Manage';
    if (row.status.kind === 'needs_input') return 'Review';
    if (row.status.kind === 'disabled') return 'Set up again';
    return undefined;
  }
  protected loadedTime(): string {
    const value = this.loadedAt();
    return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  }

  private async load(): Promise<void> {
    try {
      const response = await fetch('/org/integrations', { headers: { accept: 'application/json' } });
      const raw: unknown = await response.json().catch(() => null);
      if (response.status === 403 && integrationsRefusalSchema.safeParse(raw).success) {
        this.loadState.set('access');
        return;
      }
      if (!response.ok) throw new Error('read failed');
      const result = integrationsResponseSchema.parse(raw);
      this.rows.set(result.rows);
      this.loadedAt.set(result.loadedAt);
      this.loadState.set('ready');
    } catch {
      this.loadState.set('failed');
    }
  }
}
