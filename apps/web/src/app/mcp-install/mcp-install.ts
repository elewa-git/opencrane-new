import { ChangeDetectionStrategy, Component, signal, type OnInit } from '@angular/core';
import { z } from 'zod';
const statusSchema = z.object({ serverId: z.string(), changeRef: z.string(), state: z.enum(['checking', 'needs_input', 'failed']), reason: z.string().optional(),
  inventory: z.object({ schemaDigest: z.string(), serverInfo: z.object({ name: z.string(), version: z.string() }).default({ name: 'Server', version: 'Version not provided' }),
    tools: z.array(z.object({ name: z.string(), revision: z.string(), definition: z.string().default('Definition not stored; rediscovery required.'), readOnly: z.boolean().default(false), destructive: z.boolean().default(false) })).default([]) }).optional() });
@Component({ selector: 'oc-mcp-install', templateUrl: './mcp-install.html', styleUrl: './mcp-install.css', changeDetection: ChangeDetectionStrategy.OnPush })
export class McpInstall implements OnInit {
  protected readonly serverId = new URLSearchParams(globalThis.location.search).get('server');
  protected readonly locator = signal('');
  protected readonly phase = signal<'draft' | 'checking' | 'unknown' | 'needs_input' | 'failed' | 'access'>('draft');
  protected readonly busy = signal(false);
  protected readonly changeRef = signal('');
  protected readonly inventory = signal<z.infer<typeof statusSchema>['inventory']>(undefined);
  protected readonly message = signal('Enter the server address to discover its tools.');
  ngOnInit() {
    if (this.serverId) { this.phase.set('unknown'); void this.check(); return; }
    const saved = sessionStorage.getItem('mcp-registration');
    if (saved) {
      this.locator.set(saved); this.phase.set('unknown');
      this.message.set('? Outcome unknown · Check status to restore your change.');
    }
  }
  protected async submit(event: Event) {
    event.preventDefault(); if (this.busy() || this.phase() !== 'draft') return;
    try {
      const url = new URL(this.locator());
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid URL');
    } catch { this.message.set('× Enter an HTTPS address without credentials, a query or a fragment.'); return; }
    sessionStorage.setItem('mcp-registration', this.locator());
    this.busy.set(true); this.phase.set('checking'); this.message.set('◌ Applying / checking · Registering server…');
    try {
      const response = await fetch('/api/org/integrations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locator: this.locator() }) });
      if (this.access(response)) return;
      if (response.status === 400) { this.phase.set('draft'); this.message.set('× This address was refused. Nothing was registered.'); sessionStorage.removeItem('mcp-registration'); return; }
      if (!response.ok) throw new Error('Unknown');
      const raw: unknown = await response.json();
      this.changeRef.set(z.object({ changeRef: z.string() }).parse(raw).changeRef);
      this.message.set('◌ Applying / checking · Validating the server and discovering tools…');
    } catch { this.unknown(); } finally { this.busy.set(false); }
  }
  protected async check() {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const response = await fetch(this.serverId ? `/api/org/integrations/${encodeURIComponent(this.serverId)}/discovery` : `/api/org/integrations/discovery?locator=${encodeURIComponent(this.locator())}`);
      if (this.access(response)) return;
      if (response.status === 404 && !this.serverId) { this.phase.set('draft'); this.message.set('○ No registration was found. You can submit this source.'); sessionStorage.removeItem('mcp-registration'); return; }
      if (!response.ok) throw new Error('Unknown');
      const raw: unknown = await response.json(); const status = statusSchema.parse(raw);
      this.phase.set(status.state); this.changeRef.set(status.changeRef); this.inventory.set(status.inventory);
      this.message.set(status.state === 'checking' ? '◌ Applying / checking · Validating the server and discovering tools…'
        : status.reason === 'connection_required' ? '● Needs input · A scoped validation connection is required. Protected discovery is not available yet.'
        : status.state === 'needs_input' ? '● Needs input · Pending review. These tools are blocked.'
        : '× Server rejected · The address, protocol or tool inventory did not pass validation.');
    } catch { this.unknown(); } finally { this.busy.set(false); }
  }
  protected another() { sessionStorage.removeItem('mcp-registration'); this.locator.set(''); this.phase.set('draft'); this.inventory.set(undefined); this.changeRef.set(''); this.message.set('Enter the server address to discover its tools.'); }
  private unknown() { this.phase.set('unknown'); this.message.set('? Outcome unknown · We could not confirm the change. Check status before continuing.'); }
  private access(response: Response) {
    if (![401, 403].includes(response.status)) return false;
    this.inventory.set(undefined); this.changeRef.set(''); this.locator.set(''); sessionStorage.removeItem('mcp-registration');
    this.phase.set('access'); this.message.set('🔒 You no longer have permission. Ask an Owner or Admin.'); return true;
  }
}
