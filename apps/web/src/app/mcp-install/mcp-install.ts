import { SharedState, type PresentationState } from '../shared-state/shared-state';
import { DogEar } from '../ui/paper';
import { ChangeDetectionStrategy, Component, signal, type OnInit } from '@angular/core';
import { z } from 'zod';
const REFUSED_ADDRESS_DETAIL = 'Use a public HTTPS hostname. IP addresses, including private '
  + 'addresses, are not accepted. Nothing was registered.';
const statusSchema = z.object({ serverId: z.string(), changeRef: z.string(), state: z.enum(['checking', 'needs_input', 'failed']), reason: z.string().optional(),
  inventory: z.object({ schemaDigest: z.string(), serverInfo: z.object({ name: z.string(), version: z.string() }).default({ name: 'Server', version: 'Version not provided' }),
    tools: z.array(z.object({ name: z.string(), revision: z.string(), definition: z.string().default('Definition not stored; rediscovery required.'), readOnly: z.boolean().default(false), destructive: z.boolean().default(false) })).default([]) }).optional() });
@Component({ selector: 'oc-mcp-install', imports: [SharedState, DogEar], templateUrl: './mcp-install.html', styleUrl: './mcp-install.css', changeDetection: ChangeDetectionStrategy.OnPush })
export class McpInstall implements OnInit {
  protected readonly toolGroups = [true, false];
  protected readonly serverId = new URLSearchParams(globalThis.location.search).get('server');
  protected readonly locator = signal('');
  protected readonly phase = signal<
    'draft' | 'checking' | 'unknown' | 'needs_input' | 'failed' | 'access' | 'refused'
  >('draft');
  protected readonly busy = signal(false);
  protected readonly changeRef = signal('');
  protected readonly inventory = signal<z.infer<typeof statusSchema>['inventory']>(undefined);
  protected readonly message = signal('Enter the server address to discover its tools.');
  ngOnInit() {
    if (this.serverId) { this.phase.set('unknown'); void this.check(); return; }
    const saved = sessionStorage.getItem('mcp-registration');
    if (saved) {
      this.locator.set(saved); this.phase.set('unknown');
      this.message.set('Outcome unknown. Check status to restore your change.');
    }
  }
  protected editAddress(address: string): void {
    this.locator.set(address);
    if (this.phase() === 'refused') {
      this.phase.set('draft');
      this.message.set('Enter the server address to discover its tools.');
    }
  }
  protected async submit(event: Event) {
    event.preventDefault(); if (this.busy() || this.phase() !== 'draft') return;
    try {
      const url = new URL(this.locator());
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid URL');
    } catch { this.message.set('Enter an HTTPS address without credentials, a query or a fragment.'); return; }
    sessionStorage.setItem('mcp-registration', this.locator());
    this.busy.set(true); this.phase.set('checking'); this.message.set('Registering server…');
    try {
      const response = await fetch('/api/org/integrations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locator: this.locator() }) });
      if (this.access(response)) return;
      if (response.status === 400) {
        this.phase.set('refused');
        this.message.set('This address was refused.');
        sessionStorage.removeItem('mcp-registration');
        return;
      }
      if (!response.ok) throw new Error('Unknown');
      const raw: unknown = await response.json();
      this.changeRef.set(z.object({ changeRef: z.string() }).parse(raw).changeRef);
      this.message.set('Validating the server and discovering tools…');
    } catch { this.unknown(); } finally { this.busy.set(false); }
  }
  protected async check() {
    if (this.busy()) return;
    this.busy.set(true);
    this.message.set('Checking server status…');
    try {
      const response = await fetch(this.serverId ? `/api/org/integrations/${encodeURIComponent(this.serverId)}/discovery` : `/api/org/integrations/discovery?locator=${encodeURIComponent(this.locator())}`);
      if (this.access(response)) return;
      if (response.status === 404 && !this.serverId) { this.phase.set('draft'); this.message.set('No registration was found. You can submit this source.'); sessionStorage.removeItem('mcp-registration'); return; }
      if (!response.ok) throw new Error('Unknown');
      const raw: unknown = await response.json(); const status = statusSchema.parse(raw);
      this.phase.set(status.state); this.changeRef.set(status.changeRef); this.inventory.set(status.inventory);
      this.message.set(this.discoveryMessage(status.state, status.reason));
    } catch { this.unknown(); } finally { this.busy.set(false); }
  }
  protected presentationState(): PresentationState {
    if (this.busy()) return 'checking';
    const phase = this.phase();
    if (phase === 'access') return 'access_changed';
    if (phase === 'unknown') return 'unknown';
    return phase;
  }
  protected refusalDetail(): string | undefined {
    if (this.busy()) return undefined;
    if (this.phase() === 'refused') return REFUSED_ADDRESS_DETAIL;
    return undefined;
  }
  private discoveryMessage(state: 'checking' | 'needs_input' | 'failed', reason?: string): string {
    if (state === 'checking') {
      return 'Validating the server and discovering tools…';
    }
    if (reason === 'connection_required') {
      return 'A scoped validation connection is required. Protected discovery is unavailable.';
    }
    if (state === 'needs_input') return 'Pending review. These tools are blocked.';
    return 'Server rejected. The address, protocol or tool inventory did not pass validation.';
  }
  protected another() { sessionStorage.removeItem('mcp-registration'); this.locator.set(''); this.phase.set('draft'); this.inventory.set(undefined); this.changeRef.set(''); this.message.set('Enter the server address to discover its tools.'); }
  private unknown() { this.phase.set('unknown'); this.message.set('We could not confirm the change. Check status before continuing.'); }
  private access(response: Response) {
    if (![401, 403].includes(response.status)) return false;
    this.inventory.set(undefined); this.changeRef.set(''); this.locator.set(''); sessionStorage.removeItem('mcp-registration');
    this.phase.set('access'); this.message.set('You no longer have permission. Ask an Owner or Admin.'); return true;
  }
}
