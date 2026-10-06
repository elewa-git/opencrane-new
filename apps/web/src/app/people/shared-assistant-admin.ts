import { ChangeDetectionStrategy, Component, ElementRef, input, signal, viewChild,
  type OnDestroy, type OnInit } from '@angular/core';
import { z } from 'zod';
import { SharedState } from '../shared-state/shared-state';
import { ModalSheet } from '../ui/modal-sheet';
import type { GroupRow } from '@opencrane/protocol';
import { classifyStatus, fetchGroup, fetchGroups } from './groups-api';

const assistantRowSchema = z.object({
  assistantId: z.string(), ownerId: z.string(), kind: z.literal('team'),
  computerId: z.string().nullable(), generation: z.number(),
  status: z.enum(['claiming', 'starting', 'ready', 'suspended', 'lost', 'retired']),
  changedAt: z.string(), name: z.string().optional(), grants: z.array(z.object({
    resourceType: z.enum(['model', 'mcp_server']), resourceId: z.string(),
  })).optional(), payingGroupId: z.string().optional(), canStartSession: z.boolean(),
  busy: z.boolean(),
}).passthrough();
const assistantRowsSchema = z.object({ rows: z.array(assistantRowSchema) });
const modelListSchema = z.object({ models: z.array(z.object({
  id: z.string(), retired: z.boolean().optional(),
}).passthrough()) });
const receiptSchema = z.object({ status: z.literal('appended'), assistantId: z.string(),
  sequence: z.number(), changeId: z.string() });
const changeSchema = receiptSchema.extend({ projection: z.object({
  content: z.enum(['current', 'applying']), iam: z.enum(['current', 'applying']),
}) });
type Grant = { resourceType: 'model' | 'mcp_server'; resourceId: string };
type AssistantRow = z.infer<typeof assistantRowSchema>;
type PendingStage = 'sending' | 'recorded' | 'checking' | 'applying' | 'unknown';
type PendingCreate = { commandId: string; assistantId: string; groupId: string;
  payingGroupId: string; name: string; grants: Grant[]; stage: PendingStage };
type AdminChoices = { group: GroupRow | undefined; groups: GroupRow[];
  assistants: AssistantRow[]; models: string[] };
type AdminChoicesResult = { kind: 'ok'; value: AdminChoices }
  | { kind: 'access' } | { kind: 'unavailable' } | { kind: 'aborted' };

@Component({ selector: 'oc-shared-assistant-admin', imports: [SharedState, ModalSheet],
  templateUrl: './shared-assistant-admin.html', styleUrl: './shared-assistant-admin.css',
  changeDetection: ChangeDetectionStrategy.OnPush })
export class SharedAssistantAdmin implements OnInit, OnDestroy {
  readonly groupId = input.required<string>();
  protected readonly group = signal<GroupRow | undefined>(undefined);
  protected readonly groups = signal<GroupRow[]>([]);
  protected readonly assistants = signal<AssistantRow[]>([]);
  protected readonly models = signal<string[]>([]);
  protected readonly selectedGrants = signal<Grant[]>([]);
  protected readonly selectedPayer = signal('');
  protected readonly name = signal('');
  protected readonly loading = signal(true);
  protected readonly refreshing = signal(false);
  protected readonly failed = signal(false);
  protected readonly accessChanged = signal(false);
  protected readonly reviewOpen = signal(false);
  protected readonly notice = signal('');
  protected readonly loadMessage = signal('');
  protected readonly error = signal('');
  protected readonly pending = signal<PendingCreate | undefined>(undefined);
  protected readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  protected readonly nameField = viewChild<ElementRef<HTMLInputElement>>('nameField');
  protected readonly statusButton = viewChild<ElementRef<HTMLButtonElement>>('statusButton');
  protected readonly reviewButton = viewChild<ElementRef<HTMLButtonElement>>('reviewButton');
  private readonly request = new AbortController();
  protected readonly grantChoices = signal<Grant[]>([]);

  ngOnInit(): void { void this.load(); }

  ngOnDestroy(): void { this.request.abort(); }

  protected async load(): Promise<void> {
    const hasLoadedGroup = this.group() !== undefined;
    this.loading.set(!hasLoadedGroup);
    this.refreshing.set(hasLoadedGroup);
    this.failed.set(false);
    this.loadMessage.set('');
    const previousGroup = this.group();
    const currentPayer = this.selectedPayer();
    const userChangedPayer = previousGroup !== undefined &&
      currentPayer !== previousGroup.payingGroupId;
    const result = await this.readAdminChoices();
    if (result.kind === 'aborted') return;
    if (result.kind === 'access') {
      this.clearForAccess();
      return;
    }
    if (result.kind === 'unavailable') {
      this.showLoadFailure(hasLoadedGroup);
      return;
    }
    const currentGroup = result.value.group;
    if (!currentGroup) {
      this.showMissingGroup();
      return;
    }
    this.showAdminChoices(result.value, currentGroup, previousGroup, userChangedPayer,
      hasLoadedGroup);
  }

  protected async refresh(): Promise<void> { await this.load(); }

  private async readAdminChoices(): Promise<AdminChoicesResult> {
    try {
      const replies = await Promise.all([
        fetchGroup(this.groupId(), this.request.signal),
        fetchGroups(this.request.signal),
        fetchJson(this.request.signal, '/api/assistants'),
        fetchJson(this.request.signal, '/api/org/models'),
      ]);
      if (this.request.signal.aborted) return { kind: 'aborted' };
      const groupReply = replies[0];
      const groupsReply = replies[1];
      const assistantReply = replies[2];
      const modelReply = replies[3];
      if (groupReply.kind === 'access_changed' || groupsReply.kind === 'access_changed' ||
        isAccessReply(assistantReply) || isAccessReply(modelReply)) {
        return { kind: 'access' };
      }
      if (groupReply.kind !== 'ok' || groupsReply.kind !== 'ok' ||
        isFailedReply(assistantReply) || isFailedReply(modelReply)) {
        return { kind: 'unavailable' };
      }
      const assistantList = assistantRowsSchema.parse(assistantReply);
      const modelList = modelListSchema.parse(modelReply);
      const activeModels = modelList.models.filter(modelIsActive);
      const activeModelIds = activeModels.map(modelId);
      return { kind: 'ok', value: { group: groupReply.value, groups: groupsReply.value,
        assistants: assistantList.rows, models: activeModelIds } };
    } catch {
      if (this.request.signal.aborted) return { kind: 'aborted' };
      return { kind: 'unavailable' };
    }
  }

  private showLoadFailure(hasLoadedGroup: boolean): void {
    this.failed.set(!hasLoadedGroup);
    this.loading.set(false);
    this.refreshing.set(false);
    this.loadMessage.set('Could not load the group assistant choices.');
  }

  private showMissingGroup(): void {
    this.group.set(undefined);
    this.failed.set(true);
    this.loading.set(false);
    this.refreshing.set(false);
    this.loadMessage.set('This group is no longer available.');
  }

  private showAdminChoices(
    choices: AdminChoices,
    currentGroup: GroupRow,
    previousGroup: GroupRow | undefined,
    userChangedPayer: boolean,
    hasLoadedGroup: boolean,
  ): void {
    this.group.set(currentGroup);
    this.groups.set(choices.groups);
    this.assistants.set(choices.assistants);
    this.models.set(choices.models);
    const groupChanged = previousGroup?.groupId !== currentGroup.groupId;
    const storedPayerChanged = previousGroup?.payingGroupId !== currentGroup.payingGroupId;
    if (groupChanged || (storedPayerChanged && !userChangedPayer)) {
      this.selectedPayer.set(currentGroup.payingGroupId);
    }
    this.loading.set(false);
    this.refreshing.set(false);
    if (hasLoadedGroup) this.loadMessage.set('Updated.');
    this.syncGrantChoices(currentGroup, choices.models, previousGroup !== undefined);
  }

  protected setName(event: Event): void {
    this.name.set(readInputValue(event));
    this.error.set('');
  }

  protected setPayer(event: Event): void {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement)) return;
    this.selectedPayer.set(select.value);
  }

  protected toggleGrant(event: Event, grant: Grant): void {
    const checkbox = event.target;
    if (!(checkbox instanceof HTMLInputElement)) return;
    const current = this.selectedGrants();
    if (checkbox.checked) {
      const alreadySelected = current.some(hasGrant.bind(null, grant));
      if (alreadySelected) return;
      this.selectedGrants.set([...current, grant]);
      return;
    }
    this.selectedGrants.set(current.filter(isDifferentGrant.bind(null, grant)));
  }

  protected openReview(): void {
    if (this.isBlocked()) return;
    this.reviewOpen.set(true);
  }

  protected cancelReview(): void {
    if (this.pending()?.stage === 'sending') return;
    this.reviewOpen.set(false);
  }

  protected async create(): Promise<void> {
    if (this.isBlocked() || this.pending()) return;
    const currentGroup = this.group();
    const name = this.name().trim();
    const payer = this.selectedPayer();
    const grants = this.selectedGrants();
    if (!currentGroup || name.length < 1 || name.length > 200 || !payer || grants.length < 1) {
      this.error.set('Enter a name, choose a paying group and select at least one grant.');
      return;
    }
    const pendingCreate: PendingCreate = {
      commandId: crypto.randomUUID(), assistantId: `team-${crypto.randomUUID()}`,
      groupId: currentGroup.groupId, payingGroupId: payer, name, grants,
      stage: 'sending',
    };
    this.pending.set(pendingCreate);
    this.error.set('');
    this.notice.set('');
    await this.sendPendingCreate(pendingCreate);
  }

  protected async resendPending(): Promise<void> {
    const pendingCreate = this.pending();
    if (!pendingCreate || pendingCreate.stage !== 'unknown') return;
    const retry = { ...pendingCreate, stage: 'sending' as const };
    this.pending.set(retry);
    await this.sendPendingCreate(retry);
  }

  private async sendPendingCreate(pendingCreate: PendingCreate): Promise<void> {
    try {
      const response = await fetch('/api/assistants', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pendingCreate), signal: this.request.signal,
      });
      if (this.request.signal.aborted) return;
      const failureKind = classifyStatus(response.status, 'POST');
      const resourceRefusal = failureKind === 'refused';
      if (failureKind === 'access_changed') {
        this.clearForAccess();
        return;
      }
      if (!response.ok) {
        this.handleCreateFailure(response.status, resourceRefusal);
        return;
      }
      const receipt = receiptSchema.parse(await response.json());
      if (receipt.assistantId !== pendingCreate.assistantId) {
        this.pending.set({ ...pendingCreate, stage: 'unknown' });
        this.reviewOpen.set(false);
        this.notice.set('We could not confirm which assistant was recorded. Check its status.');
        return;
      }
      const recorded = { ...pendingCreate, stage: 'recorded' as const };
      this.pending.set(recorded);
      this.notice.set(`“${pendingCreate.name}” was recorded. The computer is set up separately. ` +
        `Reference: ${pendingCreate.commandId}.`);
      this.reviewOpen.set(false);
      await this.checkStatus();
    } catch {
      if (!this.request.signal.aborted) {
        this.pending.set({ ...pendingCreate, stage: 'unknown' });
        this.reviewOpen.set(false);
        this.notice.set('We could not tell whether this was recorded. ' +
          'Check its status before sending again.');
      }
    }
    globalThis.requestAnimationFrame(this.focusPendingStatus.bind(this));
  }

  protected async checkStatus(): Promise<void> {
    const pendingCreate = this.pending();
    if (!pendingCreate || pendingCreate.stage === 'sending' ||
      pendingCreate.stage === 'checking') return;
    const resultAfterCheck = pendingCreate.stage;
    this.pending.set({ ...pendingCreate, stage: 'checking' });
    try {
      const url = `/api/assistants/${encodeURIComponent(pendingCreate.assistantId)}` +
        `/changes/${encodeURIComponent(pendingCreate.commandId)}`;
      const response = await fetch(url, { headers: { accept: 'application/json' },
        signal: this.request.signal });
      if (this.request.signal.aborted) return;
      if (response.status === 401 || response.status === 403) {
        this.clearForAccess();
        return;
      }
      if (!response.ok) {
        if (response.status === 404) {
          // A missing record can still arrive late, so keep its ids for the safe retry.
          if (resultAfterCheck === 'recorded') {
            this.pending.set({ ...pendingCreate, stage: 'recorded' });
            this.notice.set('The assistant was recorded, but its status could not be read yet.');
          } else {
            this.pending.set({ ...pendingCreate, stage: 'unknown' });
            this.notice.set('No record was found yet. It may still arrive.');
          }
        } else {
          this.pending.set({ ...pendingCreate, stage: resultAfterCheck });
          this.notice.set(this.statusReadFailureMessage(resultAfterCheck));
        }
        return;
      }
      const change = changeSchema.parse(await response.json());
      if (change.assistantId !== pendingCreate.assistantId) {
        this.pending.set({ ...pendingCreate, stage: 'unknown' });
        this.notice.set('We could not confirm this assistant. Check its status again.');
        return;
      }
      if (change.projection.content !== 'current' || change.projection.iam !== 'current') {
        this.pending.set({ ...pendingCreate, stage: 'applying' });
        this.notice.set('The assistant is still being applied. Check its status again shortly.');
        return;
      }
      this.notice.set('The assistant is recorded and its group access link is current. ' +
        'Selected model and tool grants are added by a later step this page cannot see yet.');
      this.pending.set(undefined);
      this.clearConfirmedCreate();
      await this.load();
    } catch {
      if (!this.request.signal.aborted) {
        this.pending.set({ ...pendingCreate, stage: resultAfterCheck });
        this.notice.set(this.statusReadFailureMessage(resultAfterCheck));
      }
    }
  }

  protected isBlocked(): boolean {
    return this.loading() || this.failed() || this.accessChanged() || this.pending() !== undefined;
  }

  protected stateLabel(row: AssistantRow): string {
    if (row.status === 'ready') return 'Ready';
    if (row.status === 'claiming' || row.status === 'starting') return 'Setting up';
    if (row.status === 'lost') return 'Computer lost';
    if (row.status === 'retired') return 'Removed';
    return 'Paused';
  }

  protected stateDetail(row: AssistantRow): string {
    if (row.status === 'lost') {
      return 'The computer was lost. This page cannot report a failed setup or offer a retry.';
    }
    if (row.status === 'retired') return 'The assistant was removed.';
    if (row.busy) return 'One computer serves one run at a time.';
    return '';
  }

  protected rowForGroup(row: AssistantRow): boolean { return row.ownerId === this.groupId(); }
  protected hasAssistants(): boolean { return this.assistants().some(this.rowForGroup.bind(this)); }

  protected payerName(payerId: string | undefined): string {
    if (!payerId) return 'Not recorded';
    const payer = this.groups().find(findGroup.bind(null, payerId));
    return payer?.name ?? payerId;
  }

  protected isGrantSelected(grant: Grant): boolean {
    return this.selectedGrants().some(hasGrant.bind(null, grant));
  }

  private syncGrantChoices(group: GroupRow, modelIds: string[], keepSelections: boolean): void {
    const choices = mapGroupGrants(group.access.grants, modelIds);
    const currentSelections = this.selectedGrants();
    this.grantChoices.set(choices);
    if (!keepSelections) {
      this.selectedGrants.set([]);
      return;
    }
    const availableSelections = currentSelections.filter(isGrantAvailable.bind(null, choices));
    this.selectedGrants.set(availableSelections);
  }

  private handleCreateFailure(status: number, resourceRefusal: boolean): void {
    if (status === 400 || status === 409) {
      // These replies refuse the command before recording it, so the person can edit it.
      this.pending.set(undefined);
      this.reviewOpen.set(false);
      this.setCreateRefusal(status);
      globalThis.requestAnimationFrame(this.focusNameField.bind(this));
      return;
    }
    if (resourceRefusal) {
      this.pending.set(undefined);
      this.reviewOpen.set(false);
      this.error.set('The server refused this assistant. Check that the group, model and ' +
        'tool servers still exist, then refresh.');
      globalThis.requestAnimationFrame(this.focusNameField.bind(this));
      return;
    }
    // Keep the command ids when the server cannot say whether it recorded the request.
    const pendingCreate = this.pending();
    if (pendingCreate) this.pending.set({ ...pendingCreate, stage: 'unknown' });
    this.reviewOpen.set(false);
    this.notice.set('We could not tell whether this was recorded. ' +
      'Check its status before sending again.');
  }

  private setCreateRefusal(status: number): void {
    if (status === 400) {
      this.error.set('The server refused these details. Check the name and grants.');
      return;
    }
    this.error.set('The assistant details changed. Refresh and review before trying again.');
  }

  private clearForAccess(): void {
    this.request.abort();
    this.group.set(undefined);
    this.groups.set([]);
    this.assistants.set([]);
    this.models.set([]);
    this.grantChoices.set([]);
    this.selectedGrants.set([]);
    this.pending.set(undefined);
    this.reviewOpen.set(false);
    this.accessChanged.set(true);
    this.loading.set(false);
    this.notice.set('Your access changed. Protected group details were cleared.');
    globalThis.requestAnimationFrame(this.focusHeading.bind(this));
  }

  private statusReadFailureMessage(stage: PendingStage): string {
    if (stage === 'recorded') {
      return 'The assistant was recorded, but its status could not be read yet.';
    }
    return 'We could not tell whether this was recorded. Check its status before sending again.';
  }

  private clearConfirmedCreate(): void {
    this.name.set('');
    const nameField = this.nameField()?.nativeElement;
    if (nameField) nameField.value = '';
    this.selectedGrants.set([]);
  }

  private focusPendingStatus(): void {
    if (this.error()) {
      this.focusNameField();
      return;
    }
    const button = this.statusButton()?.nativeElement;
    if (button) {
      button.focus();
      return;
    }
    this.focusHeading();
  }

  private focusHeading(): void {
    this.heading()?.nativeElement.focus();
  }

  private focusNameField(): void {
    this.nameField()?.nativeElement.focus();
  }
}

async function fetchJson(signal: AbortSignal, url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal });
  if (!response.ok) return { httpStatus: response.status };
  return response.json();
}

function isAccessReply(reply: unknown): boolean {
  return typeof reply === 'object' && reply !== null &&
    (Reflect.get(reply, 'httpStatus') === 401 || Reflect.get(reply, 'httpStatus') === 403);
}

function isFailedReply(reply: unknown): boolean {
  return typeof reply === 'object' && reply !== null && 'httpStatus' in reply;
}

function modelIsActive(model: { id: string; retired?: boolean | undefined }): boolean {
  return !model.retired;
}
function modelId(model: { id: string }): string { return model.id; }

function mapGroupGrants(grants: GroupRow['access']['grants'], modelIds: string[]): Grant[] {
  const choices: Grant[] = [];
  for (const resourceId of modelIds) {
    choices.push({ resourceType: 'model', resourceId });
  }
  for (const grant of grants) {
    if (grant.relation !== 'use') continue;
    if (grant.resourceType === 'mcp_server') {
      choices.push({ resourceType: 'mcp_server', resourceId: grant.resourceId });
    }
  }
  const uniqueChoices: Grant[] = [];
  for (const grant of choices) {
    const alreadyIncluded = uniqueChoices.some(hasGrant.bind(null, grant));
    if (alreadyIncluded) continue;
    uniqueChoices.push(grant);
  }
  return uniqueChoices;
}

function readInputValue(event: Event): string {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return '';
  return target.value;
}

function isDifferentGrant(grant: Grant, candidate: Grant): boolean {
  return grant.resourceType !== candidate.resourceType || grant.resourceId !== candidate.resourceId;
}

function hasGrant(grant: Grant, candidate: Grant): boolean {
  return grant.resourceType === candidate.resourceType && grant.resourceId === candidate.resourceId;
}

function findGroup(groupId: string, group: GroupRow): boolean { return group.groupId === groupId; }

function isGrantAvailable(choices: Grant[], selected: Grant): boolean {
  return choices.some(hasGrant.bind(null, selected));
}
