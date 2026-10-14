import {
  ChangeDetectionStrategy, Component, computed, input, signal, type OnDestroy, type OnInit,
} from '@angular/core';
import type { GroupRow } from '@opencrane/protocol';
import { SharedState } from '../shared-state/shared-state';
import { HingeDrawer } from '../ui/hinge-drawer';
import { GrainLoader } from '../ui/grain-loader';
import { fetchGroups, followChange, sendCreateGroup } from './groups-api';
import { isDuplicateName, newGroupId, checkTimeLabel } from './group-wording';
import { GroupsList } from './groups-list';
import { MembersList } from './members-list';

type LoadState = 'loading' | 'ready' | 'failed' | 'retrying' | 'access';
type Tab = 'members' | 'groups' | 'invitations';
type PendingCreate = { commandId: string; groupId: string; name: string; receiptSeen: boolean };

@Component({
  selector: 'oc-people-screen',
  imports: [SharedState, HingeDrawer, GroupsList, MembersList, GrainLoader],
  templateUrl: './people-screen.html', styleUrls: ['./people.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PeopleScreen implements OnInit, OnDestroy {
  readonly organisationName = input.required<string>();
  protected readonly rows = signal<GroupRow[]>([]);
  protected readonly state = signal<LoadState>('loading');
  protected readonly selectedTab = signal<Tab>(
    globalThis.location.search === '?tab=groups' ? 'groups' : 'members');
  protected readonly query = signal('');
  protected readonly loadedAt = signal<string | undefined>(undefined);
  protected readonly drawerOpen = signal(false);
  protected readonly draftName = signal('');
  protected readonly sending = signal(false);
  protected readonly operation = signal('Loading groups…');
  protected readonly operationKind = signal<'checking' | 'applying' | 'confirmed' | 'unknown'
    | 'failed' | 'access_changed' | 'not_configured' | 'refused' | 'removed'>('checking');
  protected readonly changeReference = signal<string | undefined>(undefined);
  protected readonly highlightedGroupId = signal<string | undefined>(undefined);
  protected readonly checkTime = signal<string | undefined>(undefined);
  protected readonly draftError = signal('');
  protected readonly accessDetail = signal('');
  protected readonly visibleRows = computed(() => this.filteredRows());
  protected readonly tabs: readonly { id: Tab; label: string }[] = [
    { id: 'members', label: 'Members' }, { id: 'groups', label: 'Groups' },
    { id: 'invitations', label: 'Invitations' },
  ];
  private readonly request = new AbortController();
  private readInFlight = false;
  private opener?: HTMLButtonElement;
  private pendingCreate: PendingCreate | undefined;
  protected readonly retryAfterNotFound = signal(false);

  ngOnInit(): void {
    if (this.selectedTab() === 'groups') void this.load();
  }
  ngOnDestroy(): void { this.request.abort(); }

  protected select(tab: Tab): void {
    this.selectedTab.set(tab);
    if (tab === 'groups' && !this.loadedAt() && this.state() !== 'access') void this.load();
  }
  protected openDrawer(button: HTMLButtonElement): void {
    if (!this.hasUnresolvedCreate()) this.pendingCreate = undefined;
    this.opener = button;
    this.drawerOpen.set(true);
    this.draftName.set('');
    this.draftError.set('');
  }
  protected closeDrawer(): void { this.drawerOpen.set(false); }
  protected nameChanged(event: Event): void {
    this.draftName.set(inputValue(event));
    this.draftError.set('');
  }
  protected createFromEnter(event: Event): Promise<void> | undefined {
    if (!(event instanceof KeyboardEvent) || event.key !== 'Enter') return undefined;
    event.preventDefault();
    return this.create();
  }
  protected duplicate(): boolean { return isDuplicateName(this.draftName(), this.rows()); }
  protected invalidName(): boolean {
    const name = this.draftName().trim();
    return name.length < 1 || name.length > 200;
  }
  protected createDisabled(): boolean {
    const unresolvedCreate = this.hasUnresolvedCreate();
    return this.state() !== 'ready' || this.invalidName() || this.duplicate() || this.sending() ||
      unresolvedCreate;
  }
  protected hasUnresolvedCreate(): boolean {
    return this.pendingCreate !== undefined &&
      (this.operationKind() === 'unknown' || this.operationKind() === 'applying');
  }
  protected statusDetail(): string {
    if (this.operationKind() === 'applying') {
      return 'The change was recorded. Its records are not current yet.';
    }
    if (this.retryAfterNotFound()) return '';
    return 'Check its status before sending the same request again.';
  }
  protected async create(): Promise<void> {
    if (this.createDisabled()) return;
    const name = this.draftName().trim();
    if (!this.pendingCreate) {
      // Keep these ids in memory so a status check or safe retry refers to this command.
      this.pendingCreate = { commandId: crypto.randomUUID(), groupId: newGroupId(name), name,
        receiptSeen: false };
    }
    const pendingCreate = this.pendingCreate;
    if (!pendingCreate) return;
    await this.sendPendingCreate(pendingCreate);
  }

  private async sendPendingCreate(pendingCreate: PendingCreate): Promise<void> {
    this.retryAfterNotFound.set(false);
    this.sending.set(true);
    const command = {
      commandId: pendingCreate.commandId,
      groupId: pendingCreate.groupId,
      name: pendingCreate.name,
    };
    const result = await sendCreateGroup(command, this.request.signal);
    if (this.request.signal.aborted) return;
    this.sending.set(false);
    if (result.kind === 'ok') {
      pendingCreate.receiptSeen = true;
      this.drawerOpen.set(false);
      this.changeReference.set(pendingCreate.commandId);
      this.operation.set(`Creating “${pendingCreate.name}”…`);
      this.operationKind.set('applying');
      await this.completeCreate(pendingCreate);
      return;
    }
    await this.handleCreateFailure(result);
  }

  protected async load(): Promise<void> {
    const hadRows = this.loadedAt() !== undefined;
    if (this.readInFlight) return;
    this.readInFlight = true;
    this.state.set(hadRows ? 'retrying' : 'loading');
    const result = await fetchGroups(this.request.signal);
    this.readInFlight = false;
    if (this.request.signal.aborted) return;
    if (result.kind === 'ok') {
      this.rows.set(result.value);
      this.loadedAt.set(new Date().toISOString());
      this.state.set('ready');
      if (this.operationKind() === 'checking' || this.operationKind() === 'failed') {
        this.operation.set('Groups loaded');
        this.operationKind.set('checking');
      }
      return;
    }
    if (result.kind === 'access_changed') {
      this.clearForAccessChange(result.status);
      return;
    }
    this.state.set('failed');
    if (this.operationKind() === 'checking' || this.operationKind() === 'failed') {
      this.operation.set('Groups are unavailable right now');
      this.operationKind.set('failed');
    }
  }

  protected loadedTime(): string {
    const value = this.loadedAt();
    if (!value) return '';
    return `${checkTimeLabel(value)} UTC`;
  }
  protected setQuery(event: Event): void {
    this.query.set(inputValue(event));
  }
  protected clearSearch(field: HTMLInputElement): void {
    this.query.set('');
    field.focus();
  }
  protected tabKeydown(event: KeyboardEvent): void {
    let current = 0;
    for (let index = 0; index < this.tabs.length; index += 1) {
      const tab = this.tabs[index];
      if (tab?.id === this.selectedTab()) current = index;
    }
    const next = nextTabIndex(event.key, current, this.tabs.length);
    if (next < 0) return;
    event.preventDefault();
    const tab = this.tabs[next];
    if (!tab) return;
    this.select(tab.id);
    document.getElementById(`people-tab-${tab.id}`)?.focus();
  }
  protected async checkStatus(): Promise<void> {
    const pendingCreate = this.pendingCreate;
    if (!pendingCreate) return;
    await this.completeCreate(pendingCreate);
  }
  protected async resend(): Promise<void> {
    const pendingCreate = this.pendingCreate;
    if (!pendingCreate || this.sending()) return;
    await this.sendPendingCreate(pendingCreate);
  }

  private filteredRows(): GroupRow[] {
    const query = this.query().trim().toLocaleLowerCase('en-GB');
    if (!query) return this.rows();
    const visibleRows: GroupRow[] = [];
    for (const row of this.rows()) {
      if (row.name.toLocaleLowerCase('en-GB').includes(query)) visibleRows.push(row);
    }
    return visibleRows;
  }
  private async completeCreate(pendingCreate: PendingCreate): Promise<void> {
    const checked = await followChange(pendingCreate.groupId, pendingCreate.commandId,
      this.request.signal);
    if (this.request.signal.aborted) return;
    if (checked.kind === 'access_changed') {
      this.clearForAccessChange(checked.status);
      return;
    }
    if (checked.kind !== 'current') {
      this.changeReference.set(pendingCreate.commandId);
      if (checked.kind === 'not_found') {
        this.retryAfterNotFound.set(true);
        this.operationKind.set('unknown');
        this.operation.set('No record of this change yet. It may still arrive.');
        return;
      }
      if (pendingCreate.receiptSeen) {
        this.operationKind.set('applying');
        this.operation.set(`Still applying “${pendingCreate.name}”`);
        return;
      }
      this.operationKind.set('unknown');
      this.operation.set(`Couldn't confirm “${pendingCreate.name}” was created`);
      return;
    }
    // Describe when both reads were current, not when the group was created.
    this.checkTime.set(checkTimeLabel(checked.checkedAt));
    this.operation.set(`Group “${pendingCreate.name}” created`);
    this.operationKind.set('confirmed');
    this.highlightedGroupId.set(pendingCreate.groupId);
    this.pendingCreate = undefined;
    await this.load();
  }
  private async handleCreateFailure(result: Exclude<Awaited<ReturnType<typeof sendCreateGroup>>,
    { kind: 'ok' }>): Promise<void> {
    const kind = result.kind;
    if (kind === 'invalid') {
      this.pendingCreate = undefined;
      this.retryAfterNotFound.set(false);
      this.draftError.set('The server refused this name. Use 1 to 200 characters.');
      this.showResendFailure('The server refused this name. Nothing was created.');
      return;
    }
    if (kind === 'conflict') {
      this.pendingCreate = undefined;
      this.retryAfterNotFound.set(false);
      this.draftError.set('This group changed or already exists. Nothing was created. ' +
        'Cancel, refresh the list and try again.');
      this.showResendFailure('This group changed or already exists. Nothing was created.');
      return;
    }
    if (kind === 'access_changed') {
      this.clearForAccessChange(result.status);
      return;
    }
    if (kind === 'refused') {
      this.pendingCreate = undefined;
      this.retryAfterNotFound.set(false);
      await this.load();
      if (!this.request.signal.aborted && this.state() !== 'access') {
        this.draftError.set('The server refused this change. Nothing was created.');
        this.showResendFailure('The server refused this change. Nothing was created.');
      }
      return;
    }
    this.drawerOpen.set(false);
    this.changeReference.set(this.pendingCreate?.commandId);
    const groupName = this.pendingCreate?.name ?? this.draftName().trim();
    this.operation.set(`Couldn't confirm “${groupName}” was created`);
    this.retryAfterNotFound.set(false);
    this.operationKind.set('unknown');
  }
  private showResendFailure(message: string): void {
    this.operation.set(message);
    this.operationKind.set('refused');
    this.changeReference.set(undefined);
  }
  private clearForAccessChange(status?: number): void {
    // Clear protected names and references before a late response can redraw them.
    this.request.abort();
    this.rows.set([]);
    this.loadedAt.set(undefined);
    this.draftName.set('');
    this.drawerOpen.set(false);
    this.pendingCreate = undefined;
    this.retryAfterNotFound.set(false);
    this.changeReference.set(undefined);
    this.state.set('access');
    this.operationKind.set('access_changed');
    this.operation.set('Your access changed');
    this.accessDetail.set(status === 401
      ? 'Group details were cleared. Your session ended. Sign in again to continue.'
      : 'Group details were cleared. Managing groups needs the Owner or Admin role.');
  }
}

function nextTabIndex(key: string, current: number, length: number): number {
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  if (key === 'ArrowRight') return (current + 1) % length;
  if (key === 'ArrowLeft') return (current + length - 1) % length;
  return -1;
}

function inputValue(event: Event): string {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return '';
  return target.value;
}
