import { ChangeDetectionStrategy, Component, input, signal, type OnInit } from '@angular/core';
import { toolPolicySchema, type ToolPolicy } from '@opencrane/protocol';

@Component({ selector: 'oc-tool-policy', templateUrl: './tool-policy.html', styleUrl: './tool-policy.css', changeDetection: ChangeDetectionStrategy.OnPush })
export class ToolPolicyScreen implements OnInit {
  readonly serverId = input.required<string>();
  protected readonly policy = signal<ToolPolicy | undefined>(undefined);
  protected readonly state = signal<'loading' | 'ready' | 'pending' | 'error' | 'access'>('loading');
  protected readonly message = signal('◌ Loading tools…');
  protected readonly choices = signal(new Map<string, string>());
  protected readonly modes = [{ value: 'allow', label: '✓ Allow automatically' }, { value: 'ask', label: '? Ask' }, { value: 'block', label: '− Block' }];
  ngOnInit() { void this.load(); }
  protected choose(name: string, mode: string) { this.choices.update(choices => new Map(choices).set(name, mode)); }
  protected selected(tool: ToolPolicy['tools'][number]) { return this.choices().get(tool.name) ?? tool.mode; }
  protected async load() {
    this.state.set('loading'); this.message.set('◌ Loading tools…');
    try {
      const response = await fetch(this.url());
      if (this.accessChanged(response)) return;
      if (!response.ok) throw new Error('Unavailable');
      const raw: unknown = await response.json();
      this.policy.set(toolPolicySchema.parse(raw)); this.choices.set(new Map());
      this.state.set('ready'); this.message.set('Choose a mode, then save the tool.');
    } catch { this.state.set('error'); this.message.set('× Could not load tools. Check status before editing.'); }
  }
  protected async save(tool: ToolPolicy['tools'][number]) {
    const policy = this.policy();
    if (!policy || this.state() !== 'ready' || !tool.reviewed) return;
    this.state.set('pending'); this.message.set(`◌ Saving ${tool.name}…`);
    try {
      const response = await fetch(this.url(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        commandId: crypto.randomUUID(), expectedSequence: policy.sequence, connectionId: policy.connectionId,
        toolName: tool.name, toolRevision: tool.revision, mode: this.selected(tool),
      }) });
      if (this.accessChanged(response)) return;
      if (!response.ok) throw new Error(response.status === 409 ? 'changed' : 'unknown');
      const raw: unknown = await response.json();
      if (typeof raw !== 'object' || raw === null || !('policy' in raw)) throw new Error('Invalid reply');
      this.policy.set(toolPolicySchema.parse(raw.policy)); this.choices.set(new Map());
      this.state.set('ready'); this.message.set('✓ Saved');
    } catch { this.state.set('error'); this.message.set('? Could not confirm the change. Check status before editing again.'); }
  }
  private url() { return `/api/org/integrations/${encodeURIComponent(this.serverId())}/tools`; }
  private accessChanged(response: Response) {
    if (response.status !== 401 && response.status !== 403) return false;
    this.policy.set(undefined); this.choices.set(new Map()); this.state.set('access');
    this.message.set('🔒 Access changed. Ask an Owner or Admin.'); return true;
  }
}
