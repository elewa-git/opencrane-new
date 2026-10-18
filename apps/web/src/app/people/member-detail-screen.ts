import {
  ChangeDetectionStrategy, Component, ElementRef, input, signal, viewChild,
  type OnDestroy, type OnInit,
} from '@angular/core';
import { GrainLoader } from '../ui/grain-loader';
import { HingeDrawer } from '../ui/hinge-drawer';
import { ModalSheet } from '../ui/modal-sheet';
import { checkTimeLabel } from './group-wording';
import { fetchDeparture, fetchMember, fetchMemberAccess, fetchRemovalStatus,
  fetchMemberRoleStatus, sendMemberRemoval, sendMemberRole, type Access,
  type Departure, type Detail, type Header, type RemovalReceipt,
  type RoleStatus } from './members-api';

type ScreenState = 'loading' | 'ready' | 'failed' | 'missing' | 'access';
type AccessState = 'idle' | 'loading' | 'ready' | 'failed';
type Row = Access['rows'][number];
type Source = Row['sources'][number];
type Check = Row['eligibility']['person'];

@Component({
  selector: 'oc-member-detail-screen',
  imports: [GrainLoader, HingeDrawer, ModalSheet],
  templateUrl: './member-detail-screen.html',
  styleUrls: ['./people.css', './member-detail-screen.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MemberDetailScreen implements OnInit, OnDestroy {
  readonly memberId = input.required<string>();
  readonly organisationName = input('the organisation');
  protected readonly member = signal<Header | Detail | undefined>(undefined);
  protected readonly detail = signal<Detail | undefined>(undefined);
  protected readonly access = signal<Access | undefined>(undefined);
  protected readonly state = signal<ScreenState>('loading');
  protected readonly accessState = signal<AccessState>('idle');
  protected readonly memberLoadedAt = signal<string | undefined>(undefined);
  protected readonly accessLoadedAt = signal<string | undefined>(undefined);
  protected readonly denialStatus = signal<number | undefined>(undefined);
  protected readonly drawerOpen = signal(false);
  protected readonly departure = signal<Departure | undefined>(undefined);
  protected readonly departureState = signal<'loading' | 'ready' | 'failed'>('loading');
  protected readonly removalState = signal<'idle' | 'sending' | 'unknown' | 'removed'>('idle');
  protected readonly removalNotice = signal('');
  protected readonly removalReceipt = signal<RemovalReceipt | undefined>(undefined);
  protected readonly checkingStatus = signal(false);
  protected readonly lostAfterRemoval = signal(false);
  protected readonly roleOpen = signal(false);
  protected readonly chosenRole = signal<'member' | 'admin'>('member');
  protected readonly roleState = signal<'idle' | 'sending' | 'unknown' | 'applying'
    | 'confirmed' | 'unchanged'>('idle');
  protected readonly roleNotice = signal('');
  protected readonly roleChecking = signal(false);
  protected readonly checkLabel = checkLabel;
  protected readonly sectionLabel = sectionLabel;
  protected readonly sourceLabel = sourceLabel;
  protected readonly historyStatusLabel = historyStatusLabel;
  protected readonly groupSource = groupSource;
  private readonly request = new AbortController();
  private readonly accessHeading = viewChild<ElementRef<HTMLElement>>('accessHeading');
  private generation = 0;
  private drawerGeneration = 0;
  private commandId: string | undefined;
  protected roleCommandId: string | undefined;
  private roleGeneration = 0;
  protected roleOpener: HTMLButtonElement | undefined;
  protected reviewOpener: HTMLButtonElement | undefined;
  private focusTimer: number | undefined;

  ngOnInit(): void { void this.refresh(); }
  ngOnDestroy(): void {
    this.generation += 1;
    this.roleGeneration += 1;
    this.request.abort();
    if (this.focusTimer !== undefined) clearTimeout(this.focusTimer);
  }

  protected name(): string {
    return this.member()?.displayName || 'Member';
  }

  protected openRole(opener: HTMLButtonElement): void {
    const detail = this.detail();
    if (!detail?.permissions.changeRole || detail.role === 'owner'
      || this.roleCommandId || this.state() !== 'ready') return;
    this.roleOpener = opener;
    this.chosenRole.set(detail.role === 'admin' ? 'admin' : 'member');
    this.roleNotice.set('');
    this.roleOpen.set(true);
  }

  protected closeRole(): void {
    if (!this.roleOpen()) return;
    this.roleGeneration += 1;
    this.roleOpen.set(false);
    if (this.roleState() === 'sending') {
      this.roleState.set('unknown');
      this.roleNotice.set("We couldn't tell whether the role change was saved.");
    }
  }

  protected selectRole(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.value === 'member' || input.value === 'admin') this.chosenRole.set(input.value);
  }

  protected roleConfirmLabel(): string {
    const role = this.chosenRole() === 'admin' ? 'Admin' : 'Member';
    const article = role === 'Admin' ? 'an' : 'a';
    return `Make ${this.name()} ${article} ${role}`;
  }

  protected async changeRole(): Promise<void> {
    const detail = this.detail();
    if (!detail || !this.roleOpen() || this.roleState() !== 'idle'
      || this.chosenRole() === detail.role || !detail.permissions.changeRole) return;
    const generation = ++this.roleGeneration;
    const commandId = crypto.randomUUID();
    this.roleCommandId = commandId;
    this.roleState.set('sending');
    const body = { commandId, expectedSequence: detail.memberSequence,
      newRole: this.chosenRole() };
    const result = await sendMemberRole(this.memberId(), body, this.request.signal);
    if (generation !== this.roleGeneration || this.state() === 'access') return;
    if (result.kind === 'denied') { this.clearForAccessLoss(result.status); return; }
    if (result.kind === 'ok') {
      this.closeRole();
      this.roleState.set('applying');
      this.roleNotice.set('Role change saved. Access is still updating.');
      void this.checkRoleStatus();
      return;
    }
    if (result.kind === 'conflict' || result.kind === 'invalid') {
      this.roleCommandId = undefined;
      this.roleState.set('idle');
      this.closeRole();
      if (result.kind === 'conflict' && result.reason === 'ownership_stream_required') {
        this.roleNotice.set('This person is an Owner. Manage owners on the Owners page.');
      } else if (result.kind === 'conflict') {
        this.roleNotice.set('Nothing was saved. Review the latest member role.');
        void this.refresh();
      } else {
        this.roleNotice.set('The role change was not sent. Review it again.');
      }
      return;
    }
    this.roleState.set('unknown');
    this.roleNotice.set("We couldn't tell whether the role change was saved.");
  }

  protected async checkRoleStatus(): Promise<void> {
    const commandId = this.roleCommandId;
    if (!commandId || this.roleChecking()) return;
    const generation = this.roleGeneration;
    this.roleChecking.set(true);
    const result = await fetchMemberRoleStatus(this.memberId(), commandId, this.request.signal);
    this.roleChecking.set(false);
    if (generation !== this.roleGeneration || this.state() === 'access') return;
    if (result.kind === 'denied') { this.clearForAccessLoss(result.status); return; }
    if (result.kind === 'ok') { this.showRoleStatus(result.value); return; }
    this.roleState.set('unknown');
    if (result.kind === 'missing') {
      this.roleNotice.set('No result recorded yet. The original request may still arrive.');
    } else {
      this.roleNotice.set("We couldn't tell whether the role change was saved.");
    }
  }

  private showRoleStatus(status: RoleStatus): void {
    if (this.roleOpen()) this.closeRole();
    if (status.effect === 'none_target_became_owner') {
      this.roleState.set('unchanged');
      this.roleNotice.set('The role was not changed. This person became an Owner.');
      void this.refresh();
      return;
    }
    if (status.projection.content !== 'current' || status.projection.iam !== 'current') {
      this.roleState.set('applying');
      this.roleNotice.set('Role change saved. Access is still updating.');
      return;
    }
    this.roleState.set('confirmed');
    const role = status.newRole === 'admin' ? 'Admin' : 'Member';
    const article = role === 'Admin' ? 'an' : 'a';
    this.roleNotice.set(`${this.name()} is now ${article} ${role}`);
    this.roleCommandId = undefined;
    void this.refresh();
  }

  protected joinedDate(): string {
    const joinedAt = this.detail()?.joinedAt;
    if (!joinedAt) return '';
    const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric',
      timeZone: 'UTC' };
    return new Date(joinedAt).toLocaleDateString('en-GB', options);
  }

  protected loadedTime(loadedAt: string | undefined): string {
    return loadedAt ? `${checkTimeLabel(loadedAt)} UTC` : '';
  }

  protected assistantName(assistantId: string): string {
    const rows = this.access()?.rows ?? [];
    for (const row of rows) {
      if (row.resourceType === 'assistant' && row.resourceId === assistantId) {
        return row.label || row.resourceId;
      }
    }
    return assistantId;
  }

  protected openDeparture(opener: HTMLButtonElement): void {
    if (!this.detail() || this.member()?.role === 'owner' || this.state() !== 'ready') return;
    this.reviewOpener = opener;
    this.drawerOpen.set(true);
    if (!this.commandId) {
      this.removalState.set('idle');
      this.removalNotice.set('');
      void this.readDeparture();
    }
  }

  protected closeDeparture(): void {
    this.drawerGeneration += 1;
    this.drawerOpen.set(false);
    // Keep the reviewed computer facts while a removal command can still be confirmed.
    if (!this.commandId) this.departure.set(undefined);
    if (!this.commandId) this.removalState.set('idle');
    if (this.commandId && this.removalState() === 'sending') {
      this.removalState.set('unknown');
      this.removalNotice.set('The result is unknown. Check status before taking another action.');
    }
  }

  protected async readDeparture(): Promise<void> {
    if (!this.drawerOpen() || this.commandId) return;
    const generation = ++this.drawerGeneration;
    this.departure.set(undefined);
    this.departureState.set('loading');
    const result = await fetchDeparture(this.memberId(), this.request.signal);
    if (result.kind === 'denied') { this.clearForAccessLoss(result.status); return; }
    if (generation !== this.drawerGeneration || !this.drawerOpen()) return;
    if (result.kind !== 'ok') {
      this.departureState.set('failed');
      return;
    }
    this.departure.set(result.value);
    this.departureState.set('ready');
  }

  protected canRemove(): boolean {
    const review = this.departure();
    return this.drawerOpen() && this.removalState() === 'idle'
      && this.departureState() === 'ready' && !!review?.complete
      && review.permissions.remove && review.ownedSharedWork.length === 0;
  }

  protected async removeMember(): Promise<void> {
    const review = this.departure();
    if (!this.canRemove() || !review) return;
    const generation = this.drawerGeneration;
    const commandId = crypto.randomUUID();
    this.commandId = commandId;
    this.removalState.set('sending');
    const body = { commandId, expectedSequence: review.memberSequence,
      reviewRevision: review.reviewRevision };
    const result = await sendMemberRemoval(this.memberId(), body, this.request.signal);
    if (result.kind === 'denied') { this.clearForAccessLoss(result.status); return; }
    if (generation !== this.drawerGeneration || !this.drawerOpen()) return;
    if (result.kind === 'ok') {
      this.showRemovalReceipt(result.value);
      if (!result.value.projection) void this.checkRemovalStatus();
      return;
    }
    if (result.kind === 'conflict') {
      this.commandId = undefined;
      this.removalState.set('idle');
      if (result.reason === 'ownership_stream_required') {
        this.removalNotice.set('Owners step down first.');
      } else {
        this.removalNotice.set('The review changed. Check it again before removing.');
      }
      await this.readDeparture();
      return;
    }
    this.removalState.set('unknown');
    this.removalNotice.set('The result is unknown. Check status before taking another action.');
  }

  protected async checkRemovalStatus(): Promise<void> {
    const commandId = this.commandId;
    if (!commandId || this.checkingStatus()) return;
    const generation = this.drawerGeneration;
    this.checkingStatus.set(true);
    const result = await fetchRemovalStatus(this.memberId(), commandId, this.request.signal);
    this.checkingStatus.set(false);
    if (result.kind === 'denied') { this.clearForAccessLoss(result.status); return; }
    if (this.removalState() !== 'removed'
      && (generation !== this.drawerGeneration || !this.drawerOpen())) return;
    if (result.kind === 'ok') { this.showRemovalReceipt(result.value); return; }
    if (this.removalReceipt()) {
      this.removalNotice.set('Access ended. Progress is not available yet.');
      return;
    }
    this.removalState.set('unknown');
    if (result.kind === 'missing') {
      this.removalNotice.set('No result recorded yet; the original request may still arrive.');
    } else {
      this.removalNotice.set('Status is unavailable. Check again later.');
    }
  }

  private showRemovalReceipt(receipt: RemovalReceipt): void {
    this.generation += 1;
    this.removalReceipt.set(receipt);
    this.removalState.set('removed');
    this.removalNotice.set('Access ended when the removal was saved.');
    this.closeDeparture();
  }

  protected removedTime(): string {
    const time = this.removalReceipt()?.removedAt;
    if (!time) return '';
    const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short',
      year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' };
    return `${new Date(time).toLocaleString('en-GB', options)} UTC`;
  }

  protected progressLabel(part: 'iam' | 'content'): string {
    const state = this.removalReceipt()?.projection?.[part];
    const label = part === 'iam' ? 'IAM' : 'Content';
    if (state === 'current') return `${label} is current`;
    if (state === 'applying') return `${label} is still applying`;
    return `${label} status is not available yet`;
  }

  protected async refresh(): Promise<void> {
    if (this.state() === 'access' || this.removalState() === 'removed'
      || this.request.signal.aborted) return;
    const generation = ++this.generation;
    this.state.set('loading');
    const result = await fetchMember(this.memberId(), this.request.signal);
    if (this.request.signal.aborted) return;
    if (result.kind === 'denied') {
      this.clearForAccessLoss(result.status);
      return;
    }
    if (generation !== this.generation) return;
    if (result.kind === 'missing') {
      this.clearForMissingMember();
      return;
    }
    if (result.kind !== 'ok') {
      this.state.set('failed');
      return;
    }
    this.member.set(result.value);
    if (!('email' in result.value)) {
      this.detail.set(undefined);
      this.access.set(undefined);
      this.accessState.set('idle');
      this.memberLoadedAt.set(new Date().toISOString());
      this.accessLoadedAt.set(undefined);
      this.state.set('ready');
      return;
    }
    this.detail.set(result.value);
    this.memberLoadedAt.set(new Date().toISOString());
    this.state.set('ready');
    this.accessState.set('loading');
    await this.readAccess(generation);
  }

  private async readAccess(generation: number): Promise<void> {
    const result = await fetchMemberAccess(this.memberId(), this.request.signal);
    if (this.request.signal.aborted) return;
    // A refusal from any live read withdraws old detail, even if a newer read succeeded.
    if (result.kind === 'denied') {
      this.clearForAccessLoss(result.status);
      return;
    }
    if (generation !== this.generation) return;
    if (result.kind === 'missing') {
      this.clearForMissingMember();
      return;
    }
    if (result.kind !== 'ok') {
      this.accessState.set('failed');
      return;
    }
    this.access.set(result.value);
    this.accessLoadedAt.set(new Date().toISOString());
    this.accessState.set('ready');
  }

  private clearForMissingMember(): void {
    this.generation += 1;
    this.request.abort();
    this.member.set(undefined);
    this.detail.set(undefined);
    this.access.set(undefined);
    this.clearDeparture();
    this.clearRole();
    this.memberLoadedAt.set(undefined);
    this.accessLoadedAt.set(undefined);
    this.accessState.set('idle');
    this.state.set('missing');
  }

  private clearForAccessLoss(status: number): void {
    this.generation += 1;
    this.request.abort();
    this.member.set(undefined);
    this.detail.set(undefined);
    this.access.set(undefined);
    this.lostAfterRemoval.set(!!this.commandId);
    this.clearDeparture();
    this.clearRole();
    this.memberLoadedAt.set(undefined);
    this.accessLoadedAt.set(undefined);
    this.denialStatus.set(status);
    this.accessState.set('idle');
    this.state.set('access');
    this.focusTimer = globalThis.setTimeout(() => this.accessHeading()?.nativeElement.focus(), 0);
  }

  private clearDeparture(): void {
    this.drawerGeneration += 1;
    this.drawerOpen.set(false);
    this.departure.set(undefined);
    this.removalReceipt.set(undefined);
    this.commandId = undefined;
    this.removalNotice.set('');
  }

  private clearRole(): void {
    this.roleGeneration += 1;
    this.roleOpen.set(false);
    this.roleCommandId = undefined;
    this.roleNotice.set('');
  }
}

function checkLabel(check: Check): string {
  if (check === 'allowed') return 'Allowed';
  if (check === 'denied') return 'Not allowed';
  return "Couldn't check";
}

function groupSource(source: Detail['groups'][number]): string {
  return source.membershipSource === 'local' ? 'Added here' : 'From identity provider';
}

function sourceLabel(source: Source): string {
  if (source.kind === 'direct') return 'Direct grant';
  if (source.kind === 'assistant') return 'Assistant grant';
  return `Via ${source.groupName || source.groupId || 'a group'}`;
}

const sectionWords: Record<string, string> = {
  grants: 'Some grants could not be checked',
  group_membership: 'Some group memberships could not be checked',
  unsupported_grants: 'Some older grants could not be checked',
  unsupported_ownership: 'Some assistant owners could not be checked',
  inventory_index: 'The access list is still catching up',
  inventory_limits: 'The access list is too large to check fully',
  retained_content: 'Some saved content is still catching up',
  changed_inventory: 'Access changed during this read',
  permissions: 'Some permission checks were unavailable',
  tool_policy: 'Some tool settings could not be read',
  tool_limits: 'There are more tools than this list can show',
  use_availability: 'Current use could not be checked',
};

function sectionLabel(code: string): string {
  return sectionWords[code] ?? 'Another part of access could not be checked';
}

function historyStatusLabel(status: Departure['routines']['status']): string {
  if (status === 'absent_on_version') return 'None possible on this version';
  if (status === 'unsupported_history') return 'Past records cannot be checked';
  return 'Unavailable';
}
