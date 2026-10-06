import { SharedState, type PresentationState } from '../shared-state/shared-state';
import { IntegrationsAccessLost } from '../integrations/integrations-access-lost';
import { AddFlowSteps } from '../integrations/add-flow-steps';
import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
  type OnDestroy,
  type OnInit,
} from '@angular/core';
import { toolPolicySchema, type ToolPolicy } from '@opencrane/protocol';

type Tool = ToolPolicy['tools'][number];
type ToolMode = Tool['mode'];
type ScreenState = 'loading' | 'ready' | 'saving' | 'checking' | 'conflict'
  | 'unknown' | 'failed' | 'access';
type Choice = { mode: ToolMode; revision: string };
type PendingCommand = {
  commandId: string;
  toolName: string;
  toolRevision: string;
  mode: ToolMode;
  expectedSequence: number;
};

const MODE_OPTIONS: Array<{ value: ToolMode; label: string }> = [
  { value: 'allow', label: 'Allow automatically' },
  { value: 'ask', label: 'Ask' },
  { value: 'block', label: 'Block' },
];

@Component({
  selector: 'oc-tool-policy',
  imports: [SharedState, IntegrationsAccessLost, AddFlowSteps],
  templateUrl: './tool-policy.html',
  styleUrl: './tool-policy.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolPolicyScreen implements OnInit, OnDestroy {
  private readonly document = inject(DOCUMENT);
  private abortController: AbortController | undefined;
  private requestVersion = 0;
  private hadRenderedTools = false;

  readonly serverId = input.required<string>();
  protected readonly policy = signal<ToolPolicy | undefined>(undefined);
  protected readonly state = signal<ScreenState>('loading');
  protected readonly message = signal('Loading tools…');
  protected readonly detail = signal('');
  protected readonly statusKind = signal<PresentationState>('checking');
  protected readonly actionLabel = signal('');
  protected readonly changeReference = signal('');
  protected readonly showReload = signal(false);
  protected readonly choices = signal(new Map<string, Choice>());
  protected readonly pendingCommand = signal<PendingCommand | undefined>(undefined);
  protected readonly modeOptions = MODE_OPTIONS;
  protected readonly summary = computed(this.buildSummary.bind(this));

  ngOnInit(): void {
    void this.loadPolicy(false, 'Loading tools…');
  }

  ngOnDestroy(): void {
    this.requestVersion += 1;
    this.abortController?.abort();
  }

  protected choose(tool: Tool, mode: ToolMode): void {
    if (!this.canEdit(tool)) return;
    const nextChoices = new Map(this.choices());
    if (mode === tool.mode) {
      nextChoices.delete(tool.name);
      this.choices.set(nextChoices);
      return;
    }
    nextChoices.set(tool.name, { mode, revision: tool.revision });
    this.choices.set(nextChoices);
  }

  protected selected(tool: Tool): ToolMode {
    const choice = this.choices().get(tool.name);
    if (choice?.revision === tool.revision) return choice.mode;
    return tool.mode;
  }

  protected canEdit(tool: Tool): boolean {
    return this.state() === 'ready' && tool.reviewed && this.policy()?.connectionId !== null;
  }

  protected saveDisabled(tool: Tool): boolean {
    const policy = this.policy();
    if (!policy || !tool.reviewed || policy.connectionId === null) return true;
    return this.state() !== 'ready' || this.selected(tool) === tool.mode;
  }

  protected toolDescriptionId(tool: Tool): string {
    return `tool-unreviewed-${encodeURIComponent(tool.name)}`;
  }

  protected saveLabel(tool: Tool): string {
    return `Save mode for ${tool.name}`;
  }

  protected statusAction(): void {
    if (this.state() === 'unknown') {
      void this.checkStatus();
    }
  }

  protected async checkStatus(): Promise<void> {
    const command = this.pendingCommand();
    if (!command || this.state() !== 'unknown') return;
    await this.readPendingCommand(command);
  }

  protected reviewCurrentModes(): void {
    void this.loadPolicy(true, 'Loading current tool modes…');
  }

  protected discardEdits(): void {
    this.pendingCommand.set(undefined);
    this.changeReference.set('');
    void this.loadPolicy(false, 'Reloading tools…');
  }

  protected reloadTools(): void {
    const earlierChangeMayAppear = this.pendingCommand() !== undefined;
    const successMessage = earlierChangeMayAppear
      ? 'Your earlier change may still appear. Check the modes before saving again.'
      : '';
    void this.loadPolicy(false, 'Reloading tools…', successMessage);
  }

  protected toolState(tool: Tool): PresentationState {
    if (!tool.reviewed) return 'blocked';
    if (tool.mode === 'block' && this.selected(tool) === 'block') return 'draft';
    return 'ready';
  }

  protected toolStateMessage(tool: Tool): string {
    if (!tool.reviewed) return 'Unreviewed — blocked until reviewed';
    if (tool.mode === 'block' && this.selected(tool) === 'block') {
      return 'Blocked — nobody can use it';
    }
    return this.modeWords(tool.mode);
  }

  protected suggestion(tool: Tool): string {
    const suggestedMode = tool.suggestion === 'allow' ? 'Allow automatically' : 'Ask';
    return `Suggested: ${suggestedMode}. Suggestions do not grant access.`;
  }

  protected modeWords(mode: ToolMode): string {
    if (mode === 'allow') return 'Allow automatically';
    if (mode === 'ask') return 'Ask';
    return 'Block';
  }

  protected async save(tool: Tool): Promise<void> {
    const policy = this.policy();
    if (!policy || !this.canSave(tool, policy)) return;
    const command = this.createCommand(tool, policy);
    this.pendingCommand.set(command);
    this.changeReference.set(command.commandId);
    this.state.set('saving');
    this.showReload.set(false);
    this.statusKind.set('applying');
    this.message.set(`Saving ${tool.name}…`);
    this.detail.set('');
    this.actionLabel.set('');

    const version = this.beginRequest();
    try {
      const response = await fetch(this.toolsUrl(), this.postOptions(command));
      if (!this.isCurrent(version)) return;
      if (this.clearOnAccessLoss(response)) return;
      if (response.status === 409) {
        this.showConflict('The tools changed before your save',
          'Your save was based on an older copy of these tools. Nothing was saved and '
          + 'nothing has been overwritten. Review the current modes before saving again.');
        return;
      }
      if (response.status === 400) {
        this.pendingCommand.set(undefined);
        this.state.set('failed');
        this.statusKind.set('failed');
        this.message.set('Failed — nothing changed');
        this.detail.set('The server refused this change as invalid. Nothing was saved.');
        this.actionLabel.set('');
        return;
      }
      if (!response.ok) {
        this.showUnknown(command);
        return;
      }
      const reply = await this.readSavedPolicy(response);
      if (!this.isCurrent(version)) return;
      this.applySavedPolicy(reply, command);
    } catch {
      if (this.isCurrent(version)) this.showUnknown(command);
    } finally {
      this.finishRequest(version);
    }
  }

  private async loadPolicy(
    preserveUnchangedChoices: boolean,
    loadingMessage: string,
    successMessage = '',
  ): Promise<void> {
    if (this.state() === 'access') return;
    const previousPolicy = this.policy();
    const previousChoices = this.choices();
    this.state.set('loading');
    this.showReload.set(false);
    this.statusKind.set('checking');
    this.message.set(loadingMessage);
    this.detail.set('');
    this.actionLabel.set('');

    const version = this.beginRequest();
    try {
      const response = await fetch(this.toolsUrl(), this.getOptions());
      if (!this.isCurrent(version)) return;
      if (this.clearOnAccessLoss(response)) return;
      if (!response.ok) {
        this.showPolicyReadFailure();
        return;
      }
      const rawReply: unknown = await response.json();
      const policy = toolPolicySchema.parse(rawReply);
      if (!this.isCurrent(version)) return;
      this.policy.set(policy);
      if (policy.tools.length > 0) this.hadRenderedTools = true;
      this.choices.set(preserveUnchangedChoices
        ? this.choicesForCurrentTools(previousPolicy, previousChoices, policy)
        : new Map<string, Choice>());
      this.pendingCommand.set(undefined);
      this.changeReference.set('');
      this.state.set('ready');
      this.statusKind.set(successMessage ? 'needs_input' : 'ready');
      this.message.set(successMessage);
      this.detail.set('');
    } catch {
      if (this.isCurrent(version)) this.showPolicyReadFailure();
    } finally {
      this.finishRequest(version);
    }
  }

  private async readPendingCommand(command: PendingCommand): Promise<void> {
    this.state.set('checking');
    this.showReload.set(false);
    this.statusKind.set('checking');
    this.message.set(`Checking change ${command.commandId}…`);
    this.detail.set("Reads the saved policy. Doesn't send the change again.");
    this.actionLabel.set('');
    const version = this.beginRequest();
    try {
      const response = await fetch(this.toolsUrl(), this.getOptions());
      if (!this.isCurrent(version)) return;
      if (this.clearOnAccessLoss(response)) return;
      if (!response.ok) {
        this.showCheckFailure();
        return;
      }
      const rawReply: unknown = await response.json();
      const policy = toolPolicySchema.parse(rawReply);
      if (!this.isCurrent(version)) return;
      this.comparePendingCommand(policy, command);
    } catch {
      if (this.isCurrent(version)) this.showCheckFailure();
    } finally {
      this.finishRequest(version);
    }
  }

  private comparePendingCommand(policy: ToolPolicy, command: PendingCommand): void {
    const savedTool = policy.tools.find(hasName(command.toolName));
    if (policy.sequence === command.expectedSequence) {
      this.state.set('unknown');
      this.showReload.set(true);
      this.statusKind.set('unknown');
      this.message.set('Still unknown');
      this.detail.set(`No change recorded yet at ${this.currentTime()}. Check again in a moment.`);
      this.actionLabel.set('Check status');
      this.policy.set(policy);
      return;
    }
    if (policy.sequence > command.expectedSequence
      && savedTool?.revision === command.toolRevision && savedTool.mode === command.mode) {
      this.policy.set(policy);
      this.choices.set(this.choicesWithout(command.toolName));
      this.pendingCommand.set(undefined);
      this.changeReference.set('');
      this.state.set('ready');
      this.statusKind.set('confirmed');
      this.message.set('Saved policy matches your change');
      this.detail.set(`The saved policy shows ${command.toolName} as `
        + `${this.modeWords(command.mode)}. Checked at ${this.currentTime()}.`);
      this.actionLabel.set('');
      return;
    }
    if (policy.sequence > command.expectedSequence) {
      this.pendingCommand.set(undefined);
      this.showConflict('The tools changed before your save',
        'The tools changed after your save. We can’t tell whether your change applied first. '
        + 'Review the current modes.');
      return;
    }
    this.showCheckFailure();
  }

  private showConflict(message: string, detail: string): void {
    this.state.set('conflict');
    this.statusKind.set('needs_input');
    this.message.set(message);
    this.detail.set(detail);
    this.actionLabel.set('');
    this.pendingCommand.set(undefined);
    this.changeReference.set('');
  }

  private showUnknown(command: PendingCommand): void {
    this.pendingCommand.set(command);
    this.state.set('unknown');
    this.showReload.set(true);
    this.statusKind.set('unknown');
    this.message.set('Outcome unknown');
    this.detail.set('The reply was lost while saving. The change may or may not have applied. '
      + 'Check status before doing anything else.');
    this.actionLabel.set('Check status');
    this.changeReference.set(command.commandId);
  }

  private showCheckFailure(): void {
    this.state.set('unknown');
    this.statusKind.set('unknown');
    this.message.set("Couldn't check. The change is still unknown.");
    this.detail.set('Reload tools to read the current saved modes.');
    this.actionLabel.set('Check status');
  }

  private showReadFailure(): void {
    this.state.set('failed');
    this.showReload.set(true);
    this.statusKind.set('failed');
    this.message.set("Couldn't load tools.");
    this.detail.set('Reload tools to try the read again.');
    this.actionLabel.set('');
  }

  private showPolicyReadFailure(): void {
    if (this.pendingCommand()) {
      this.showCheckFailure();
      return;
    }
    this.showReadFailure();
  }

  private applySavedPolicy(policy: ToolPolicy, command: PendingCommand): void {
    this.policy.set(policy);
    this.choices.set(this.choicesWithout(command.toolName));
    this.pendingCommand.set(undefined);
    this.changeReference.set(command.commandId);
    this.state.set('ready');
    this.statusKind.set('confirmed');
    this.message.set(`Saved ${command.toolName}: ${this.modeWords(command.mode)}`);
    this.detail.set('');
    this.actionLabel.set('');
  }

  private createCommand(tool: Tool, policy: ToolPolicy): PendingCommand {
    return {
      commandId: crypto.randomUUID(),
      toolName: tool.name,
      toolRevision: tool.revision,
      mode: this.selected(tool),
      expectedSequence: policy.sequence,
    };
  }

  private canSave(tool: Tool, policy: ToolPolicy): boolean {
    return this.state() === 'ready' && tool.reviewed && policy.connectionId !== null
      && this.selected(tool) !== tool.mode;
  }

  private postOptions(command: PendingCommand): RequestInit {
    const policy = this.policy();
    const body = {
      ...command,
      connectionId: policy?.connectionId,
      expectedSequence: command.expectedSequence,
    };
    return {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.abortController?.signal ?? null,
    };
  }

  private getOptions(): RequestInit {
    return { method: 'GET', signal: this.abortController?.signal ?? null };
  }

  private async readSavedPolicy(response: Response): Promise<ToolPolicy> {
    const rawReply: unknown = await response.json();
    if (typeof rawReply !== 'object' || rawReply === null || !('policy' in rawReply)) {
      throw new Error('The save reply did not include a policy');
    }
    return toolPolicySchema.parse(rawReply.policy);
  }

  private choicesForCurrentTools(
    previousPolicy: ToolPolicy | undefined,
    previousChoices: Map<string, Choice>,
    currentPolicy: ToolPolicy,
  ): Map<string, Choice> {
    if (!previousPolicy) return new Map();
    const keptChoices = new Map<string, Choice>();
    for (const previousTool of previousPolicy.tools) {
      const choice = previousChoices.get(previousTool.name);
      if (!choice) continue;
      const currentTool = currentPolicy.tools.find(hasName(previousTool.name));
      if (!currentTool || !currentTool.reviewed || currentTool.revision !== choice.revision) continue;
      keptChoices.set(currentTool.name, choice);
    }
    return keptChoices;
  }

  private choicesWithout(toolName: string): Map<string, Choice> {
    const nextChoices = new Map(this.choices());
    nextChoices.delete(toolName);
    return nextChoices;
  }

  private buildSummary(): string {
    const policy = this.policy();
    if (!policy) return '';
    let allowCount = 0;
    let askCount = 0;
    let blockCount = 0;
    for (const tool of policy.tools) {
      const mode = this.selected(tool);
      if (mode === 'allow') allowCount += 1;
      if (mode === 'ask') askCount += 1;
      if (mode === 'block') blockCount += 1;
    }
    const counts = `${allowCount} Allow automatically · ${askCount} Ask · ${blockCount} Block.`;
    if (!policy.published) {
      return `${counts} Nobody can use these tools yet: this server is not published and access `
        + 'grants are not available yet.';
    }
    return `${counts} Saved modes apply only to people and assistants who have a current grant. `
      + "Grants can't be read here yet.";
  }

  private currentTime(): string {
    const now = new Date();
    const time = now.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
      hourCycle: 'h23',
    });
    return `${time} UTC`;
  }

  private toolsUrl(): string {
    return `/api/org/integrations/${encodeURIComponent(this.serverId())}/tools`;
  }

  private beginRequest(): number {
    this.abortController?.abort();
    this.abortController = new AbortController();
    this.requestVersion += 1;
    return this.requestVersion;
  }

  private finishRequest(version: number): void {
    if (this.requestVersion === version) this.abortController = undefined;
  }

  private isCurrent(version: number): boolean {
    return this.requestVersion === version && this.state() !== 'access';
  }

  clearOnAccessLoss(response: Response): boolean {
    if (response.status !== 401 && response.status !== 403) return false;
    this.requestVersion += 1;
    this.abortController?.abort();
    this.abortController = undefined;
    this.policy.set(undefined);
    this.choices.set(new Map());
    this.pendingCommand.set(undefined);
    this.changeReference.set('');
    this.state.set('access');
    this.showReload.set(false);
    this.statusKind.set('access_changed');
    this.message.set('Access changed. Ask an Owner or Admin.');
    this.detail.set('');
    if (this.hadRenderedTools) globalThis.setTimeout(this.focusAccessHeading, 0);
    return true;
  }

  private focusAccessHeading = (): void => {
    const heading = this.document.querySelector<HTMLElement>('#integration-access-heading');
    heading?.focus();
  };
}

function hasName(name: string): (tool: Tool) => boolean {
  return (tool) => tool.name === name;
}
