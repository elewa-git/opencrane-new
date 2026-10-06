import { ChangeDetectionStrategy, Component, ElementRef, input, signal, viewChild,
  type OnDestroy, type OnInit } from '@angular/core';
import { z } from 'zod';
import { SharedState } from '../shared-state/shared-state';
import { ModalSheet } from '../ui/modal-sheet';
import type { GroupRow } from '@opencrane/protocol';

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
type PendingCreate = { commandId: string; assistantId: string; groupId: string;
  payingGroupId: string; name: string; grants: Grant[] };

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
  protected readonly failed = signal(false);
  protected readonly accessChanged = signal(false);
  protected readonly reviewOpen = signal(false);
  protected readonly sending = signal(false);
  protected readonly statusReading = signal(false);
  protected readonly notice = signal('');
  protected readonly error = signal('');
  protected readonly pending = signal<PendingCreate | undefined>(undefined);
  protected readonly reference = signal('');
  protected readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  protected readonly statusButton = viewChild<ElementRef<HTMLButtonElement>>('statusButton');
  protected readonly reviewButton = viewChild<ElementRef<HTMLButtonElement>>('reviewButton');
  private readonly request = new AbortController();
  protected readonly grantChoices = signal<Grant[]>([]);

  async ngOnInit(): Promise<void> { await this.load(); }

  ngOnDestroy(): void { this.request.abort(); }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    const urls = [
      `/api/groups/${encodeURIComponent(this.groupId())}`,
      '/api/groups', '/api/assistants', '/api/org/models',
    ];
    try {
      const replies = await Promise.all(urls.map(fetchJson.bind(null, this.request.signal)));
      if (this.request.signal.aborted) return;
      if (replies.some(isAccessReply)) {
        this.clearForAccess();
        return;
      }
      if (replies.some(isFailedReply)) throw new Error('A required list could not be read');
      const groupList = z.object({ rows: z.array(groupSchema) }).parse(replies[1]);
      const assistantList = assistantRowsSchema.parse(replies[2]);
      const modelList = modelListSchema.parse(replies[3]);
      const requestedGroup = z.object({ rows: z.array(groupSchema).max(1) }).parse(replies[0]);
      const currentGroup = requestedGroup.rows[0];
      if (!currentGroup) {
        this.group.set(undefined);
        this.failed.set(true);
        this.notice.set('This group is no longer available.');
        return;
      }
      this.group.set(currentGroup);
      this.groups.set(groupList.rows);
      this.assistants.set(assistantList.rows);
      const activeModels = modelList['models'].filter(modelIsActive);
      const activeModelIds = activeModels.map(modelId);
      this.models.set(activeModelIds);
      this.selectedPayer.set(currentGroup.payingGroupId);
      this.loading.set(false);
      this.syncGrantChoices(currentGroup, activeModelIds);
    } catch {
      if (this.request.signal.aborted) return;
      this.failed.set(true);
      this.loading.set(false);
      this.notice.set('Could not load the group assistant choices.');
    }
  }

  protected async refresh(): Promise<void> { await this.load(); }

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
      this.selectedGrants.set([...current, grant]);
      return;
    }
    this.selectedGrants.set(current.filter(isDifferentGrant.bind(null, grant)));
  }

  protected openReview(): void {
    if (this.isBlocked()) return;
    this.reviewOpen.set(true);
  }

  protected cancelReview(): void { this.reviewOpen.set(false); }

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
    };
    this.pending.set(pendingCreate);
    this.sending.set(true);
    this.error.set('');
    this.reference.set(pendingCreate.commandId);
    try {
      const response = await fetch('/api/assistants', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...pendingCreate, grants }), signal: this.request.signal,
      });
      if (this.request.signal.aborted) return;
      if (response.status === 401 || response.status === 403) {
        this.clearForAccess();
        return;
      }
      if (!response.ok) {
        if (response.status === 400 || response.status === 409) {
          this.pending.set(undefined);
          this.reference.set('');
          this.error.set(response.status === 400
            ? 'The server refused these details. Check the name and grants.'
            : 'The assistant could not be created because its details changed. Refresh and review.');
        } else {
          this.notice.set('We could not tell whether this was recorded. Check its status before sending again.');
        }
        return;
      }
      const receipt = receiptSchema.parse(await response.json());
      if (receipt.assistantId !== pendingCreate.assistantId) {
        this.notice.set('We could not confirm which assistant was recorded. Check its status.');
        return;
      }
      this.reference.set(receipt.changeId);
      this.notice.set(`“${pendingCreate.name}” was recorded. Its computer is being set up.`);
      this.reviewOpen.set(false);
      await this.checkStatus();
    } catch {
      if (!this.request.signal.aborted) {
        this.notice.set('We could not tell whether this was recorded. Check its status before sending again.');
      }
    } finally {
      this.sending.set(false);
      globalThis.requestAnimationFrame(this.focusPendingStatus.bind(this));
    }
  }

  protected async checkStatus(): Promise<void> {
    const pendingCreate = this.pending();
    if (!pendingCreate || this.statusReading()) return;
    this.statusReading.set(true);
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
        this.notice.set('We could not tell whether this was recorded. Check its status before sending again.');
        return;
      }
      const change = changeSchema.parse(await response.json());
      if (change.assistantId !== pendingCreate.assistantId) {
        this.notice.set('We could not confirm this assistant. Check its status again.');
        return;
      }
      if (change.projection.content !== 'current' || change.projection.iam !== 'current') {
        this.notice.set('The assistant is still being applied. Check its status again shortly.');
        return;
      }
      this.notice.set('The assistant record and access changes are current.');
      this.pending.set(undefined);
      await this.load();
    } catch {
      if (!this.request.signal.aborted) {
        this.notice.set('We could not tell whether this was recorded. Check its status before sending again.');
      }
    } finally { this.statusReading.set(false); }
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

  private syncGrantChoices(group: GroupRow, modelIds: string[]): void {
    const choices = mapGroupGrants(group.access.grants, modelIds);
    this.grantChoices.set(choices);
    this.selectedGrants.set([]);
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
    this.reference.set('');
    this.reviewOpen.set(false);
    this.accessChanged.set(true);
    this.loading.set(false);
    this.notice.set('Your access changed. Protected group details were cleared.');
    globalThis.requestAnimationFrame(this.focusHeading.bind(this));
  }

  private focusPendingStatus(): void {
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
}

const groupSchema = z.object({
  groupId: z.string(), name: z.string(), membershipSource: z.enum(['local', 'identity_provider']),
  position: z.number(), payingGroupId: z.string(),
  members: z.array(z.object({ memberId: z.string(), displayName: z.string(),
    membershipSource: z.enum(['local', 'identity_provider']) })),
  access: z.object({ source: z.literal('group_membership'), conversationAccess: z.literal(false),
    personalMemoryAccess: z.literal(false), grants: z.array(z.object({ resourceType: z.string(),
      resourceId: z.string(), relation: z.enum(['use', 'acts_for']) })) }),
});

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
