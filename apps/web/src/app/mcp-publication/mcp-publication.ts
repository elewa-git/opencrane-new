import { ChangeDetectionStrategy, Component, input, output, signal, type OnInit } from '@angular/core';
import { toolPolicySchema } from '@opencrane/protocol';
import { z } from 'zod';
const person = z.object({ id: z.string(), kind: z.enum(['member', 'team', 'assistant']), name: z.string() });
const view = z.object({ state: z.enum(['needs_review', 'applying', 'ready', 'removed', 'unknown']), sequence: z.number(), changeRef: z.string().optional(), digest: z.string().optional(),
  policy: toolPolicySchema, grants: z.array(z.object({ granteeId: z.string(), granteeKind: z.string() })), grantSequence: z.number(), candidates: z.array(person), affectedUsers: z.array(person) });
interface Inventory { schemaDigest: string; tools: { name: string; revision: string; readOnly: boolean; destructive: boolean }[] }
@Component({ selector: 'oc-mcp-publication', templateUrl: './mcp-publication.html', styleUrl: './mcp-publication.css', changeDetection: ChangeDetectionStrategy.OnPush })
export class McpPublication implements OnInit {
  readonly reviewed = output<boolean>();
  readonly blocked = output<boolean>();
  readonly reviewRequested = output<void>();
  readonly serverId = input.required<string>();
  readonly inventory = input.required<Inventory>();
  protected readonly state = signal<z.infer<typeof view> | undefined>(undefined);
  protected readonly busy = signal(false);
  protected readonly unknown = signal(false);
  protected readonly message = signal('Loading publication…');
  protected readonly modes = signal(new Map<string, string>());
  protected readonly account = signal('none');
  protected readonly free = signal(false);
  protected readonly selected = signal('');
  protected readonly removing = signal(false);
  protected readonly choices = [{ mode: 'allow', label: 'Allow automatically' }, { mode: 'ask', label: 'Ask' }, { mode: 'block', label: 'Block' }];
  ngOnInit() { void this.load(); }
  protected mode(name: string) { return this.modes().get(name) ?? this.state()?.policy.tools.find(t => t.name === name)?.mode ?? 'block'; }
  protected choose(name: string, value: string) { this.modes.update(m => new Map(m).set(name, value)); }
  protected name(id: string, kind: string) { return this.state()?.candidates.find(c => c.id === id && c.kind === kind)?.name ?? id; }
  protected assistants() { return this.state()?.grants.filter(g => g.granteeKind === 'assistant').length ?? 0; }
  protected async load() {
    this.busy.set(true); this.blocked.emit(true);
    try {
      const changeRef = sessionStorage.getItem(this.key());
      const response = await fetch(`${this.url('publication')}${changeRef ? `?changeRef=${encodeURIComponent(changeRef)}` : ''}`);
      if (this.accessChanged(response)) return;
      if (!response.ok) throw new Error('Unknown');
      const raw: unknown = await response.json(); const status = view.parse(raw);
      this.state.set(status); this.reviewed.emit(!['needs_review', 'unknown'].includes(status.state)); this.unknown.set(status.state === 'unknown'); this.blocked.emit(['applying', 'unknown'].includes(status.state));
      this.message.set(({ needs_review: '● Review each tool before publication. No one gains access by installing.', applying: '◌ Applying · Waiting for the gateway to acknowledge this configuration.',
        ready: '✓ Ready · The gateway acknowledged this reviewed configuration.', removed: '− Disabled / removed · History kept. The upstream account is unchanged.', unknown: '? Outcome unknown · Check status before continuing.' })[status.state]);
      if (status.state !== 'unknown') sessionStorage.removeItem(this.key());
    } catch { this.unknown.set(true); this.message.set('? Outcome unknown · Check status before continuing.'); }
    finally { this.busy.set(false); }
  }
  protected async publish() {
    const state = this.state(); if (!state) return;
    await this.send('publication', { expectedSequence: state.sequence, schemaDigest: this.inventory().schemaDigest, accountMode: this.account(),
      tools: this.inventory().tools.map(t => ({ name: t.name, revision: t.revision, mode: this.mode(t.name), ...(this.free() ? { costCents: 0 } : {}) })) });
  }
  protected async grant(action: 'give' | 'revoke', id?: string, kind?: string) {
    const selected = this.state()?.candidates.find(c => `${c.kind}:${c.id}` === this.selected());
    await this.send('grants', { expectedSequence: this.state()!.grantSequence, granteeId: id ?? selected?.id, granteeKind: kind ?? selected?.kind, action });
  }
  protected async remove() { await this.send('remove', { expectedSequence: this.state()!.sequence }); this.removing.set(false); }
  private async send(path: string, body: object) {
    if (this.busy() || this.unknown()) return;
    this.busy.set(true); this.blocked.emit(true); const commandId = crypto.randomUUID(); sessionStorage.setItem(this.key(), commandId);
    this.message.set('◌ Applying change…');
    try {
      const response = await fetch(this.url(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId, ...body }) });
      if (this.accessChanged(response)) return;
      if ([400, 409].includes(response.status)) {
        sessionStorage.removeItem(this.key()); this.modes.set(new Map()); await this.load(); this.reviewRequested.emit();
        this.message.set('The change was not applied. Review the current settings before continuing.'); return;
      }
      if (!response.ok) throw new Error('Unknown');
      await this.load();
    } catch { this.unknown.set(true); this.message.set('? Outcome unknown · Check status before continuing.'); }
    finally { this.busy.set(false); }
  }
  private accessChanged(response: Response) {
    if (![401, 403].includes(response.status)) return false;
    this.state.set(undefined); this.unknown.set(true); this.blocked.emit(true); this.reviewRequested.emit();
    this.message.set('🔒 Access changed. Ask an Owner or Admin.'); return true;
  }
  private url(path: string) { return `/api/org/integrations/${encodeURIComponent(this.serverId())}/${path}`; }
  private key() { return `mcp-publication-${this.serverId()}`; }
}
