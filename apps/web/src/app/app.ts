import { Claim } from './claim/claim';
import { AuditScreen } from './audit/audit';
import { McpInstall } from './mcp-install/mcp-install';
import { ModelsScreen } from './models/models';
import { ToolPolicyScreen } from './tool-policy/tool-policy';
import { ChangeDetectionStrategy, Component, type OnInit, computed, inject, signal } from '@angular/core';
import { integrationsResponseSchema, type IntegrationRow, type SharedStateKind } from '@opencrane/protocol';
import { Workspace } from './chat/workspace';
import { SignIn } from './sign-in/sign-in';
import { WebSocketService } from './core/websocket.service';
import { SharedState } from './shared-state/shared-state';
import { StateSpecimen } from './shared-state/state-specimen';
import { PaperSurface } from './ui/paper';
import { GrainLoader } from './ui/grain-loader';

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
  selector: 'app-root', imports: [Claim, StateSpecimen, PaperSurface, GrainLoader, McpInstall, SharedState, SignIn, Workspace, ToolPolicyScreen, ModelsScreen, AuditScreen], templateUrl: './app.html', styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush, host: { '[class.workspace-root]': 'workspacePage' },
})
export class App implements OnInit {
  private readonly ws = inject(WebSocketService);
  protected readonly claimPage = globalThis.location.pathname === '/claim';
  protected readonly workspacePage = globalThis.location.pathname === '/workspace';
  protected readonly orgPage = globalThis.location.pathname.startsWith('/org');
  protected readonly installPage = globalThis.location.pathname === '/org/integrations/new';
  protected readonly toolServer = /^\/org\/integrations\/([\w-]+)\/tools$/u.exec(globalThis.location.pathname)?.[1];
  protected readonly historyPage = globalThis.location.pathname === '/org/history';
  protected readonly auditConversation = /^\/history\/([\w-]+)$/u.exec(globalThis.location.pathname)?.[1];
  protected readonly modelsPage = globalThis.location.pathname === '/org/models';
  protected readonly statesPage = globalThis.location.pathname.endsWith('/states');
  protected readonly examples = STATE_EXAMPLES;
  protected readonly skeletonWidths = ['48%', '65%', '54%', '72%'];
  protected readonly rows = signal<IntegrationRow[]>([]);
  protected readonly selectedTab = signal<Tab>('all');
  protected readonly loadState = signal<LoadState>('loading');
  protected readonly loadedAt = signal<string | undefined>(undefined);
  protected readonly menuOpen = signal(false);
  protected readonly attention = computed(() => this.rows().filter((row) =>
    ['needs_input', 'failed', 'unknown', 'access_changed'].includes(row.status.kind)));
  protected readonly reviews = computed(() => this.rows().filter((row) =>
    row.status.kind === 'needs_input' && row.status.detail.toLowerCase().includes('pending review')));
  protected readonly visibleRows = computed(() => this.selectedTab() === 'all' ? this.rows()
    : this.selectedTab() === 'attention' ? this.attention() : this.reviews());

  ngOnInit(): void {
    if (this.orgPage) this.ws.connect();
    if (this.orgPage && !this.statesPage && !this.toolServer && !this.modelsPage && !this.historyPage && !this.installPage) void this.load();
  }

  protected select(tab: Tab): void { this.selectedTab.set(tab); }
  protected refresh(): void {
    if (this.loadState() === 'loading' || this.loadState() === 'retrying') return;
    this.loadState.set('retrying');
    void this.load();
  }
  protected tabKeydown(event: KeyboardEvent): void {
    const tabs: Tab[] = ['all', 'attention', 'review'];
    const current = tabs.indexOf(this.selectedTab());
    let next = -1;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (current + tabs.length - 1) % tabs.length;
    if (next < 0) return;
    event.preventDefault();
    const tab = tabs[next]!;
    this.select(tab);
    globalThis.document.getElementById(`integrations-tab-${tab}`)?.focus();
  }
  protected emptyFilterMessage(): string {
    return this.selectedTab() === 'attention' ? 'No servers need attention' : 'No servers are pending review';
  }
  protected tools(row: IntegrationRow): string {
    return row.toolsTotal === null ? '—' : `${row.toolsAllowed} of ${row.toolsTotal}`;
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

  protected loadMessage(): string {
    const state = this.loadState();
    if (state === 'loading') return 'Loading integrations…';
    if (state === 'access') return 'Integration access changed';
    return 'Integrations loaded';
  }

  private async load(): Promise<void> {
    try {
      const response = await fetch('/api/org/integrations', { headers: { accept: 'application/json' } });
      const raw: unknown = await response.json().catch(() => null);
      if (response.status === 401 || response.status === 403) {
        this.rows.set([]);
        this.loadedAt.set(undefined);
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
