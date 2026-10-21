import { IntegrationDetail, readStoredPublication } from '../integrations/integration-detail';
import { SharedState, type PresentationState } from '../shared-state/shared-state';
import { IntegrationsAccessLost } from '../integrations/integrations-access-lost';
import { AddFlowSteps } from '../integrations/add-flow-steps';
import {
  initialToolPolicy, initialModeDisabled, TOOL_MODE_OPTIONS,
  choicesDifferentFromSaved,
  choicesForCurrentTools,
  choicesWithout,
  type ToolChoice,
} from './tool-policy-choices';
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
type PendingCommand = {
  commandId: string;
  connectionId: string | null;
  toolName: string;
  toolRevision: string;
  mode: ToolMode;
  expectedSequence: number;
};


@Component({
  selector: 'oc-tool-policy',
  imports: [SharedState, IntegrationsAccessLost, AddFlowSteps, IntegrationDetail],
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
  protected readonly reviewSnapshot = signal<ToolPolicy | undefined>(undefined);
  protected readonly policy = signal<ToolPolicy | undefined>(undefined);
  protected readonly state = signal<ScreenState>('loading');
  protected readonly message = signal('Loading tools…');
  protected readonly detail = signal('');
  protected readonly statusKind = signal<PresentationState>('checking');
  protected readonly changeReference = signal('');
  protected readonly showReload = signal(false);
  protected readonly choices = signal(new Map<string, ToolChoice>());
  protected readonly pendingCommand = signal<PendingCommand | undefined>(undefined);
  protected readonly modeOptions = TOOL_MODE_OPTIONS;
  protected readonly summary = computed(this.buildSummary.bind(this));

  ngOnInit(): void {
    void this.loadPolicy(false, 'Loading tools…');
  }

  ngOnDestroy(): void {
    // Ignore replies that arrive after this page has closed.
    this.requestVersion += 1;
    this.abortController?.abort();
  }

  protected choose(tool: Tool, mode: ToolMode): void {
    if (!this.canEdit(tool) || this.modeDisabled(tool, mode)) return;
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
    return this.state() === 'ready' && (tool.reviewed || this.isInitial()) &&
      this.policy()?.connectionId !== null;
  }

  protected isInitial(): boolean {
    return initialToolPolicy(this.policy());
  }

  protected modeDisabled(tool: Tool, mode: ToolMode): boolean {
    return mode !== 'block' && initialModeDisabled(this.policy(), tool.name);
  }

  protected openReview(): void {
    const policy = this.policy();
    if (!policy || !this.isInitial() || this.state() !== 'ready') return;
    const tools: Tool[] = [];
    for (const tool of policy.tools) tools.push({ ...tool, mode: this.selected(tool) });
    this.reviewSnapshot.set({ ...policy, tools });
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
    this.focusStatusRegion();
  }

  protected discardEdits(): void {
    this.pendingCommand.set(undefined);
    this.changeReference.set('');
    void this.loadPolicy(false, 'Reloading tools…');
    this.focusStatusRegion();
  }

  protected reloadTools(): void {
    const earlierChangeMayAppear = this.pendingCommand() !== undefined;
    this.changeReference.set('');
    const successMessage = earlierChangeMayAppear
      ? 'Your earlier change may still appear. Check the modes before saving again.'
      : '';
    void this.loadPolicy(true, 'Reloading tools…', successMessage);
    this.focusStatusRegion();
  }

  protected hasUnsavedChoice(tool: Tool): boolean {
    const choice = this.choices().get(tool.name);
    return choice?.revision === tool.revision && choice.mode !== tool.mode;
  }

  protected toolsBusy(): boolean {
    return this.state() === 'loading' || this.state() === 'saving'
      || this.state() === 'checking';
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
        this.choices.set(choicesWithout(this.choices(), command.toolName));
        this.pendingCommand.set(undefined);
        this.changeReference.set('');
        this.state.set('ready');
        this.showReload.set(true);
        this.statusKind.set('failed');
        this.message.set('Failed — nothing changed');
        this.detail.set('The server refused this change as invalid. Nothing was saved.');
        this.focusStatusRegion();
        return;
      }
      if (!response.ok) {
        this.showUnknown(command);
        return;
      }
      const reply = await this.readSavedPolicy(response);
      if (!this.isCurrent(version)) return;
      this.applySavedPolicy(reply, command);
      this.focusStatusRegion();
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

    const version = this.beginRequest();
    try {
      const response = await fetch(this.toolsUrl(), this.getOptions());
      if (!this.isCurrent(version)) return;
      if (this.clearOnAccessLoss(response)) return;
      if (!response.ok) {
        if (response.status === 400 && !this.pendingCommand()) {
          this.showNotReadyFailure();
          return;
        }
        this.showPolicyReadFailure();
        return;
      }
      const rawReply: unknown = await response.json();
      const policy = toolPolicySchema.parse(rawReply);
      if (!this.isCurrent(version)) return;
      this.policy.set(policy);
      this.restorePublication(policy);
      if (policy.tools.length > 0) this.hadRenderedTools = true;
      const keptChoices = preserveUnchangedChoices
        ? choicesForCurrentTools(previousPolicy, previousChoices, policy)
        : new Map<string, ToolChoice>();
      this.choices.set(choicesDifferentFromSaved(keptChoices, policy));
      this.pendingCommand.set(undefined);
      if (!successMessage) this.changeReference.set('');
      this.state.set('ready');
      this.statusKind.set(successMessage ? 'needs_input' : 'ready');
      this.message.set(successMessage);
      this.detail.set('');
      this.focusStatusRegion();
    } catch {
      if (this.isCurrent(version)) this.showPolicyReadFailure();
    } finally {
      this.finishRequest(version);
    }
  }

  private restorePublication(policy: ToolPolicy): void {
    if (readStoredPublication(this.serverId())) this.reviewSnapshot.set(policy);
  }

  private async readPendingCommand(command: PendingCommand): Promise<void> {
    this.state.set('checking');
    this.showReload.set(false);
    this.statusKind.set('checking');
    this.message.set(`Checking change ${command.commandId}…`);
    this.detail.set("Reads the saved policy. Doesn't send the change again.");
    this.focusStatusRegion();
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
      this.policy.set(policy);
      this.choices.set(choicesDifferentFromSaved(this.choices(), policy));
      this.state.set('unknown');
      this.showReload.set(true);
      this.statusKind.set('unknown');
      this.message.set('Still unknown');
      this.detail.set(`No change recorded yet at ${this.currentTime()}. Check again in a moment.`);
      this.focusStatusAction();
      return;
    }
    if (policy.sequence > command.expectedSequence
      && savedTool?.revision === command.toolRevision && savedTool.mode === command.mode) {
      this.policy.set(policy);
      const otherChoices = choicesWithout(this.choices(), command.toolName);
      this.choices.set(choicesDifferentFromSaved(otherChoices, policy));
      this.pendingCommand.set(undefined);
      this.state.set('ready');
      this.statusKind.set('confirmed');
      this.message.set('Saved policy matches your change');
      this.detail.set(`The saved policy shows ${command.toolName} as `
        + `${this.modeWords(command.mode)}. Checked at ${this.currentTime()}.`);
      this.focusStatusRegion();
      return;
    }
    if (policy.sequence > command.expectedSequence) {
      this.pendingCommand.set(undefined);
      this.policy.set(policy);
      this.choices.set(choicesDifferentFromSaved(this.choices(), policy));
      this.changeReference.set(command.commandId);
      this.showConflict('The saved modes don’t match your change',
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
    this.pendingCommand.set(undefined);
  }

  private showUnknown(command: PendingCommand): void {
    this.pendingCommand.set(command);
    this.state.set('unknown');
    this.showReload.set(false);
    this.statusKind.set('unknown');
    this.message.set('Outcome unknown');
    this.detail.set('The reply was lost while saving. The change may or may not have applied. '
      + 'Check status before doing anything else.');
    this.changeReference.set(command.commandId);
  }

  private showCheckFailure(): void {
    this.state.set('unknown');
    this.showReload.set(true);
    this.statusKind.set('unknown');
    this.message.set("Couldn't check. The change is still unknown.");
    this.detail.set('Reload tools to read the current saved modes.');
    this.focusStatusRegion();
  }

  private showReadFailure(): void {
    this.state.set('failed');
    this.showReload.set(true);
    this.statusKind.set('failed');
    this.message.set("Couldn't load tools.");
    this.detail.set('Reload tools to try the read again.');
  }

  private showNotReadyFailure(): void {
    this.state.set('failed');
    this.showReload.set(true);
    this.statusKind.set('needs_input');
    this.message.set('Not ready yet: discovery is still being recorded.');
    this.detail.set('Reload tools to check again.');
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
    const otherChoices = choicesWithout(this.choices(), command.toolName);
    this.choices.set(choicesDifferentFromSaved(otherChoices, policy));
    this.pendingCommand.set(undefined);
    this.changeReference.set(command.commandId);
    this.state.set('ready');
    this.statusKind.set('confirmed');
    this.message.set(`Saved ${command.toolName}: ${this.modeWords(command.mode)}`);
    this.detail.set('');
  }

  private createCommand(tool: Tool, policy: ToolPolicy): PendingCommand {
    return {
      commandId: crypto.randomUUID(),
      connectionId: policy.connectionId,
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
    return {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
      signal: this.abortController?.signal ?? null,
    };
  }

  private getOptions(): RequestInit {
    return { method: 'GET', signal: this.abortController?.signal ?? null };
  }

  private async readSavedPolicy(response: Response): Promise<ToolPolicy> {
    if (response.status !== 200) throw new Error('The save was not confirmed');
    const rawReply: unknown = await response.json();
    if (typeof rawReply !== 'object' || rawReply === null || !('policy' in rawReply)
      || !('status' in rawReply) || rawReply.status !== 'appended') {
      throw new Error('The save reply did not include a policy');
    }
    return toolPolicySchema.parse(rawReply.policy);
  }

  private focusStatusRegion(): void {
    // Remove the pressed button before moving focus to the status message.
    globalThis.setTimeout(this.focusToolStatusRegion, 0);
  }

  private focusStatusAction(): void {
    globalThis.setTimeout(this.focusCheckStatusAction, 0);
  }

  private focusToolStatusRegion = (): void => {
    const statusRegion = this.document.querySelector<HTMLElement>('#tool-status');
    statusRegion?.focus();
  };

  private focusCheckStatusAction = (): void => {
    const action = this.document.querySelector<HTMLButtonElement>(
      '.tool-policy > .notice-actions .state-action',
    );
    action?.focus();
  };

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
      return `${counts} Nobody can use these tools yet: this server is not published. `
        + 'Publishing does not create grants.';
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
    // Ignore a reply if a newer request started or access was refused.
    return this.requestVersion === version && this.state() !== 'access';
  }

  protected clearOnAccessLoss(response: Response): boolean {
    if (response.status !== 401 && response.status !== 403) return false;
    this.requestVersion += 1;
    this.abortController?.abort();
    this.abortController = undefined;
    this.reviewSnapshot.set(undefined);
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
