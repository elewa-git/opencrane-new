import { SharedState, type PresentationState } from '../shared-state/shared-state';
import { ChangeDetectionStrategy, Component, input, signal, type OnInit } from '@angular/core';
import { toolPolicySchema, type ToolPolicy } from '@opencrane/protocol';

@Component({
  selector: 'oc-tool-policy',
  imports: [SharedState],
  templateUrl: './tool-policy.html',
  styleUrl: './tool-policy.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolPolicyScreen implements OnInit {
  readonly serverId = input.required<string>();
  protected readonly policy = signal<ToolPolicy | undefined>(undefined);
  protected readonly state = signal<'loading' | 'ready' | 'pending' | 'error' | 'access'>('loading');
  protected readonly message = signal('Loading tools…');
  protected readonly statusKind = signal<PresentationState>('checking');
  protected readonly evidenceAt = signal<string | undefined>(undefined);
  protected readonly changeReference = signal('');
  protected readonly choices = signal(new Map<string, string>());
  protected readonly modes = [
    { value: 'allow', label: '✓ Allow automatically' },
    { value: 'ask', label: '? Ask' },
    { value: 'block', label: '− Block' },
  ];
  ngOnInit(): void {
    void this.load();
  }
  protected choose(name: string, mode: string): void {
    const choices = new Map(this.choices());
    choices.set(name, mode);
    this.choices.set(choices);
  }
  protected selected(tool: ToolPolicy['tools'][number]): string {
    return this.choices().get(tool.name) ?? tool.mode;
  }
  protected async load(): Promise<void> {
    this.state.set('loading');
    this.statusKind.set('checking');
    this.evidenceAt.set(undefined);
    this.message.set('Loading tools…');
    try {
      const response = await fetch(this.url());
      if (this.accessChanged(response)) return;
      if (!response.ok) throw new Error('Unavailable');
      const raw: unknown = await response.json();
      const policy = toolPolicySchema.parse(raw);
      this.policy.set(policy);
      this.choices.set(new Map());
      this.state.set('ready');
      this.statusKind.set('needs_input');
      this.message.set('Choose a mode, then save the tool.');
    } catch {
      this.state.set('error');
      this.statusKind.set('failed');
      this.message.set('Could not load tools. Check status before editing.');
    }
  }
  protected async save(tool: ToolPolicy['tools'][number]): Promise<void> {
    const policy = this.policy();
    if (!policy || this.state() !== 'ready' || !tool.reviewed) return;
    this.state.set('pending');
    this.statusKind.set('applying');
    this.evidenceAt.set(undefined);
    this.message.set(`Saving ${tool.name}…`);
    const command = {
      commandId: crypto.randomUUID(), expectedSequence: policy.sequence,
      connectionId: policy.connectionId, toolName: tool.name,
      toolRevision: tool.revision, mode: this.selected(tool),
    };
    this.changeReference.set(command.commandId);
    const options: RequestInit = {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    };
    try {
      const response = await fetch(this.url(), options);
      if (this.accessChanged(response)) return;
      if (!response.ok) throw new Error(response.status === 409 ? 'changed' : 'unknown');
      const raw: unknown = await response.json();
      if (typeof raw !== 'object' || raw === null || !('policy' in raw)) throw new Error('Invalid reply');
      const savedPolicy = toolPolicySchema.parse(raw.policy);
      this.policy.set(savedPolicy);
      this.choices.set(new Map());
      this.state.set('ready');
      this.statusKind.set('confirmed');
      this.evidenceAt.set(new Date().toISOString());
      this.message.set('Saved tool policy projection read');
    } catch {
      this.state.set('error');
      this.statusKind.set('unknown');
      this.message.set('Could not confirm the change. Check status before editing again.');
    }
  }
  private url(): string {
    return `/api/org/integrations/${encodeURIComponent(this.serverId())}/tools`;
  }
  private accessChanged(response: Response): boolean {
    if (response.status !== 401 && response.status !== 403) return false;
    this.changeReference.set('');
    this.policy.set(undefined);
    this.choices.set(new Map());
    this.state.set('access');
    this.statusKind.set('access_changed');
    this.evidenceAt.set(undefined);
    this.message.set('Access changed. Ask an Owner or Admin.');
    return true;
  }
}
