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

type LoadState = 'loading' | 'ready' | 'failed' | 'retrying' | 'access';
type Tab = 'members' | 'groups' | 'invitations';

@Component({ selector: 'oc-people-screen', imports: [SharedState, HingeDrawer, GroupsList, GrainLoader],
  templateUrl: './people-screen.html', styleUrls: ['./people.css'],
  changeDetection: ChangeDetectionStrategy.OnPush })
export class PeopleScreen implements OnInit, OnDestroy {
  readonly organisationName = input.required<string>();
  protected readonly rows = signal<GroupRow[]>([]);
  protected readonly state = signal<LoadState>('loading');
  protected readonly selectedTab = signal<Tab>('groups');
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
  private command: { commandId: string; groupId: string; name: string } | undefined;

  ngOnInit(): void { void this.load(); }
  ngOnDestroy(): void { this.request.abort(); }

  protected select(tab: Tab): void { this.selectedTab.set(tab); }
  protected openDrawer(button: HTMLButtonElement): void {
    this.opener = button;
    this.drawerOpen.set(true);
    this.draftName.set('');
    this.draftError.set('');
    this.command = undefined;
  }
  protected closeDrawer(): void { this.drawerOpen.set(false); }
  protected nameChanged(event: Event): void {
    this.draftName.set(inputValue(event));
    this.draftError.set('');
  }
  protected duplicate(): boolean { return isDuplicateName(this.draftName(), this.rows()); }
  protected invalidName(): boolean {
    const name = this.draftName().trim();
    return name.length < 1 || name.length > 200;
  }
  protected createDisabled(): boolean {
    return this.state() !== 'ready' || this.invalidName() || this.duplicate() || this.sending();
  }
  protected async create(): Promise<void> {
    if (this.createDisabled()) return;
    const name = this.draftName().trim();
    if (!this.command) {
      // Keep these ids in memory so a status check or safe retry refers to this command.
      this.command = { commandId: crypto.randomUUID(), groupId: newGroupId(name), name };
    }
    this.sending.set(true);
    const result = await sendCreateGroup(this.command, this.request.signal);
    if (this.request.signal.aborted) return;
    this.sending.set(false);
    if (result.kind === 'ok') {
      this.drawerOpen.set(false);
      this.changeReference.set(this.command.commandId);
      this.operation.set(`Creating “${name}”…`);
      this.operationKind.set('applying');
      await this.completeCreate(name, this.command.groupId, this.command.commandId);
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
      if (this.operationKind() === 'checking') this.operation.set('Groups loaded');
      return;
    }
    if (result.kind === 'access_changed') {
      this.clearForAccessChange(result.status);
      return;
    }
    this.state.set('failed');
    this.operation.set('Groups are unavailable right now');
    this.operationKind.set('failed');
  }

  protected async refresh(): Promise<void> { await this.load(); }
  protected loadedTime(): string {
    const value = this.loadedAt();
    if (!value) return '';
    const options: Intl.DateTimeFormatOptions = {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC',
    };
    return new Date(value).toLocaleTimeString('en-GB', options) + ' UTC';
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
    if (!this.command) return;
    await this.completeCreate(this.command.name, this.command.groupId, this.command.commandId);
  }
  protected async resend(): Promise<void> {
    if (!this.command) return;
    await this.create();
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
  private async completeCreate(name: string, groupId: string, commandId: string): Promise<void> {
    const checked = await followChange(groupId, commandId, this.request.signal);
    if (this.request.signal.aborted) return;
    if (checked.kind === 'access_changed') {
      this.clearForAccessChange(checked.status);
      return;
    }
    if (checked.kind !== 'current') {
      this.operationKind.set(checked.kind === 'not_found' ? 'unknown' : 'unknown');
      this.operation.set(checked.kind === 'not_found'
        ? 'No record of this change yet. It may still arrive.'
        : `Still applying “${name}”`);
      return;
    }
    // Describe when both reads were current, not when the group was created.
    this.checkTime.set(checkTimeLabel(checked.checkedAt));
    this.operation.set(`Group “${name}” created`);
    this.operationKind.set('confirmed');
    this.highlightedGroupId.set(groupId);
    await this.loadAfterChange();
  }
  private async loadAfterChange(): Promise<void> {
    await this.load();
  }
  private async handleCreateFailure(result: Exclude<Awaited<ReturnType<typeof sendCreateGroup>>,
    { kind: 'ok' }>): Promise<void> {
    const kind = result.kind;
    if (kind === 'invalid') { this.draftError.set('The server refused this name. Use 1 to 200 characters.'); return; }
    if (kind === 'conflict') {
      this.draftError.set('This group changed or already exists. Nothing was created. Cancel, refresh the list and try again.');
      return;
    }
    if (kind === 'access_changed') {
      this.clearForAccessChange(result.status);
      return;
    }
    if (kind === 'refused') {
      await this.load();
      if (!this.request.signal.aborted && this.state() !== 'access') {
        this.draftError.set('The server refused this change. Nothing was created.');
      }
      return;
    }
    this.drawerOpen.set(false);
    this.operation.set(`Couldn't confirm “${this.draftName().trim()}” was created`);
    this.operationKind.set('unknown');
  }
  private clearForAccessChange(status?: number): void {
    // Clear protected names and references before a late response can redraw them.
    this.request.abort();
    this.rows.set([]);
    this.loadedAt.set(undefined);
    this.draftName.set('');
    this.drawerOpen.set(false);
    this.command = undefined;
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
