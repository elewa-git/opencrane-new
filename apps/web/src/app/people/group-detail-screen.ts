import {
  ChangeDetectionStrategy, Component, ElementRef, input, signal, viewChild,
  type OnDestroy, type OnInit,
} from '@angular/core';
import type { GroupRow } from '@opencrane/protocol';
import { SharedState, type PresentationState } from '../shared-state/shared-state';
import { GrainLoader } from '../ui/grain-loader';
import { ModalSheet } from '../ui/modal-sheet';
import { fetchGroup, followChange, sendAddMember, sendRemoveMember,
  type Outcome } from './groups-api';
import { GroupAddPanel } from './group-add-panel';
import type { MemberDirectory } from './member-search-api';
import { GroupDetail, type RemoveRequested } from './group-detail';
import { checkTimeLabel, grantResourceLabel } from './group-wording';

type ScreenState = 'loading' | 'ready' | 'missing' | 'failed' | 'access';
type ActionState = 'idle' | 'applying' | 'unknown' | 'conflict' | 'refused' | 'confirmed';
type Member = GroupRow['members'][number];
type PendingChange = { action: 'add' | 'remove'; commandId: string;
  memberId: string; displayName: string };
const ACCEPTED_REMOVAL_DETAIL = 'The server accepted the change. Its records are not current yet.';
const UNKNOWN_REMOVAL_DETAIL =
  'We could not tell whether the server recorded it. Check its status before retrying.';
const MEMBERSHIP_CHANGED_DETAIL =
  'The person may have left the organisation, or their membership may now come from ' +
  'your identity provider.';

@Component({ selector: 'oc-group-detail-screen',
  imports: [SharedState, GroupDetail, GroupAddPanel, ModalSheet, GrainLoader],
  templateUrl: './group-detail-screen.html',
  styleUrls: ['./people.css', './group-add-panel.css'],
  changeDetection: ChangeDetectionStrategy.OnPush })
export class GroupDetailScreen implements OnInit, OnDestroy {
  readonly groupId = input.required<string>();
  protected readonly group = signal<GroupRow | undefined>(undefined);
  protected readonly state = signal<ScreenState>('loading');
  protected readonly actionState = signal<ActionState>('idle');
  protected readonly statusKind = signal<PresentationState>('checking');
  protected readonly statusMessage = signal('Loading group…');
  protected readonly detail = signal('');
  protected readonly reviewOpen = signal(false);
  protected readonly addOpen = signal(false);
  protected readonly reviewMember = signal<Member | undefined>(undefined);
  protected readonly pendingChange = signal<PendingChange | undefined>(undefined);
  protected readonly membersUnavailable = signal(false);
  protected readonly changeReference = signal<string | undefined>(undefined);
  protected readonly grantResourceLabel = grantResourceLabel;
  private readonly request = new AbortController();
  private readInFlight = false;
  protected readonly pollInFlight = signal(false);
  private focusTimer: number | undefined;
  protected reviewOpener: HTMLButtonElement | undefined;
  private draftCommand: { commandId: string; memberId: string } | undefined;
  private receiptSeen = false;
  protected readonly retryAfterNotFound = signal(false);
  private readonly headingElement = viewChild<ElementRef<HTMLElement>>('detailHeading');
  private readonly addPanel = viewChild(GroupAddPanel);

  ngOnInit(): void { void this.load(); }
  ngOnDestroy(): void {
    this.request.abort();
    if (this.focusTimer !== undefined) globalThis.clearTimeout(this.focusTimer);
  }

  protected heading(): string {
    if (this.state() === 'access') return 'Group details';
    if (this.state() === 'missing') return 'Group not found';
    return this.group()?.name ?? 'Group details';
  }

  protected reviewTitle(): string {
    const member = this.reviewMember();
    const group = this.group();
    if (!member || !group) return 'Remove member?';
    return `Remove ${member.displayName} from ${group.name}?`;
  }

  protected reviewGrants(): GroupRow['access']['grants'] {
    return this.group()?.access.grants ?? [];
  }

  protected openReview(requested: RemoveRequested): void {
    const group = this.group();
    if (this.changesBlocked() || !group || group.membershipSource !== 'local'
        || requested.member.membershipSource !== 'local') return;
    this.reviewOpener = requested.opener;
    this.reviewMember.set(requested.member);
    this.draftCommand = { commandId: crypto.randomUUID(), memberId: requested.member.memberId };
    this.reviewOpen.set(true);
  }

  protected openAdd(): void {
    const group = this.group();
    if (!group || group.membershipSource !== 'local' || this.changesBlocked()) return;
    this.addOpen.set(true);
    globalThis.setTimeout(this.focusAddPanel.bind(this), 0);
  }

  private focusAddPanel(): void {
    this.addPanel()?.focus();
  }

  protected addMember(member: MemberDirectory['rows'][number]): void {
    const group = this.group();
    if (!group || group.membershipSource !== 'local' || this.changesBlocked()) return;
    const displayName = member.displayName || member.email;
    this.pendingChange.set({ action: 'add', commandId: crypto.randomUUID(),
      memberId: member.memberId, displayName });
    this.receiptSeen = false;
    this.changeReference.set(this.pendingChange()?.commandId);
    this.actionState.set('applying');
    this.statusKind.set('applying');
    this.statusMessage.set(`Adding ${displayName} to ${group.name}…`);
    this.detail.set('');
    void this.sendChange();
  }

  protected closeReview(): void {
    this.reviewOpen.set(false);
    this.reviewMember.set(undefined);
    this.draftCommand = undefined;
  }

  protected async confirmRemoval(): Promise<void> {
    const group = this.group();
    const member = this.reviewMember();
    const command = this.draftCommand;
    if (!group || !member || !command || this.pendingChange()) return;
    this.reviewOpen.set(false);
    this.pendingChange.set({ action: 'remove', commandId: command.commandId,
      memberId: member.memberId, displayName: member.displayName });
    this.receiptSeen = false;
    this.changeReference.set(command.commandId);
    this.actionState.set('applying');
    this.statusKind.set('applying');
    this.statusMessage.set(`Sending the removal request for ${member.displayName}…`);
    this.detail.set('');
    await this.sendChange();
  }

  protected async refresh(): Promise<void> {
    if (this.actionState() === 'conflict' || this.actionState() === 'refused') {
      await this.refreshAfterNotice();
      return;
    }
    await this.load();
  }

  protected async refreshMembers(): Promise<void> {
    if (!this.membersUnavailable()) return;
    await this.readAfterConfirmedChange();
  }

  protected async checkStatus(): Promise<void> {
    const pendingChange = this.pendingChange();
    if (!pendingChange || this.pollInFlight()) return;
    this.actionState.set(this.receiptSeen ? 'applying' : 'unknown');
    this.statusKind.set(this.receiptSeen ? 'applying' : 'unknown');
    const groupName = this.group()?.name ?? 'the group';
    if (pendingChange.action === 'remove') {
      this.statusMessage.set(checkingRemovalMessage(pendingChange.displayName, groupName));
    } else {
      this.statusMessage.set(`Checking the addition for ${pendingChange.displayName}…`);
    }
    await this.followPendingChange();
  }

  protected async resendRemoval(): Promise<void> {
    const pendingChange = this.pendingChange();
    if (!pendingChange || this.pollInFlight()) return;
    this.actionState.set('applying');
    this.statusKind.set('applying');
    if (pendingChange.action === 'remove') {
      this.statusMessage.set(`Sending the same removal request for ${pendingChange.displayName}…`);
    } else {
      this.statusMessage.set(`Adding ${pendingChange.displayName} to ${this.groupName()}…`);
    }
    await this.sendChange();
  }

  protected async load(): Promise<void> {
    if (this.readInFlight || this.pollInFlight() || this.pendingChange()
        || this.request.signal.aborted) return;
    this.readInFlight = true;
    this.state.set('loading');
    this.statusKind.set('checking');
    this.statusMessage.set('Loading group…');
    const result = await fetchGroup(this.groupId(), this.request.signal);
    this.readInFlight = false;
    if (this.request.signal.aborted) return;
    this.acceptRead(result);
  }

  private async sendChange(): Promise<void> {
    const pendingChange = this.pendingChange();
    if (!pendingChange || this.request.signal.aborted) return;
    const body = { action: pendingChange.action, commandId: pendingChange.commandId,
      memberId: pendingChange.memberId };
    const result = pendingChange.action === 'add'
      ? await sendAddMember(this.groupId(), body, this.request.signal)
      : await sendRemoveMember(this.groupId(), body, this.request.signal);
    if (this.request.signal.aborted) return;
    if (result.kind === 'ok') {
      this.receiptSeen = true;
      const pendingChange = this.pendingChange();
      if (pendingChange) {
        this.actionState.set('applying');
        this.statusKind.set('applying');
        if (pendingChange.action === 'remove') {
          this.statusMessage.set(`Still applying the removal for ${pendingChange.displayName}`);
        } else {
          this.statusMessage.set(`Adding ${pendingChange.displayName} to ${this.groupName()}…`);
        }
        this.detail.set('The server accepted the change. Checking that its records are current.');
      }
      await this.followPendingChange();
      return;
    }
    await this.handleChangeFailure(result);
  }

  private async followPendingChange(): Promise<void> {
    const pendingChange = this.pendingChange();
    if (!pendingChange || this.request.signal.aborted) return;
    this.pollInFlight.set(true);
    const result = await followChange(
      this.groupId(), pendingChange.commandId, this.request.signal,
    );
    this.pollInFlight.set(false);
    if (this.request.signal.aborted) return;
    if (result.kind === 'access_changed') {
      this.clearForAccessChange(result.status);
      return;
    }
    if (result.kind === 'not_found') {
      this.retryAfterNotFound.set(true);
      this.actionState.set('unknown');
      this.statusKind.set('unknown');
      this.statusMessage.set('No record of this change yet. It may still arrive.');
      this.detail.set('');
      return;
    }
    if (result.kind !== 'current') {
      if (this.receiptSeen) {
        this.actionState.set('applying');
        this.statusKind.set('applying');
        if (pendingChange.action === 'remove') {
          this.statusMessage.set(`Still applying the removal for ${pendingChange.displayName}`);
        } else {
          this.statusMessage.set(`Adding ${pendingChange.displayName} to ${this.groupName()}…`);
        }
        this.detail.set(ACCEPTED_REMOVAL_DETAIL);
      } else {
        this.actionState.set('unknown');
        this.statusKind.set('unknown');
        this.statusMessage.set(pendingChange.action === 'remove'
          ? "Couldn't confirm the removal" : "Couldn't confirm the addition");
        this.detail.set(UNKNOWN_REMOVAL_DETAIL);
      }
      return;
    }
    this.retryAfterNotFound.set(false);
    this.actionState.set('confirmed');
    this.statusKind.set('confirmed');
    if (pendingChange.action === 'remove') {
      this.statusMessage.set(`Removed ${pendingChange.displayName} from ${this.groupName()}`);
    } else {
      this.statusMessage.set(`Added ${pendingChange.displayName} to ${this.groupName()}`);
    }
    const checkedAt = checkTimeLabel(result.checkedAt);
    this.detail.set(
      `Group and access records were current when checked at ${checkedAt} UTC.`,
    );
    this.membersUnavailable.set(false);
    await this.readAfterConfirmedChange();
  }

  private async handleChangeFailure(
    result: Exclude<Awaited<ReturnType<typeof sendRemoveMember>>, { kind: 'ok' }>,
  ): Promise<void> {
    if (result.kind === 'access_changed') {
      this.clearForAccessChange(result.status);
      return;
    }
    if (result.kind === 'conflict') {
      this.clearPendingChange();
      this.actionState.set('conflict');
      this.statusKind.set('failed');
      this.statusMessage.set('Membership changed while you were looking');
      this.detail.set("Refresh to see the current list. Your change wasn't applied.");
      return;
    }
    if (result.kind === 'refused') {
      await this.readForRefusal();
      return;
    }
    if (result.kind === 'invalid') {
      this.showRefusedRemoval('');
      return;
    }
    this.actionState.set('unknown');
    this.statusKind.set('unknown');
    this.statusMessage.set(this.pendingChange()?.action === 'remove'
      ? "Couldn't confirm the removal" : "Couldn't confirm the addition");
    this.detail.set(UNKNOWN_REMOVAL_DETAIL);
  }

  private async readForRefusal(): Promise<void> {
    const result = await this.readGroupOnce();
    if (this.request.signal.aborted) return;
    if (result.kind === 'access_changed') {
      this.clearForAccessChange(result.status);
      return;
    }
    if (result.kind === 'ok') {
      if (!result.value) {
        this.acceptRead(result);
        this.clearPendingChange();
        return;
      }
      this.acceptGroup(result.value);
    }
    let refusalDetail = '';
    if (result.kind === 'ok') refusalDetail = MEMBERSHIP_CHANGED_DETAIL;
    this.showRefusedRemoval(refusalDetail);
    this.clearPendingChange();
  }

  private showRefusedRemoval(detail: string): void {
    this.actionState.set('refused');
    this.statusKind.set('refused');
    this.statusMessage.set(this.pendingChange()?.action === 'add'
      ? 'This addition was refused. Nothing changed.'
      : 'This removal was refused. Nothing changed.');
    this.detail.set(detail);
  }

  private async refreshAfterNotice(): Promise<void> {
    const result = await this.readGroupOnce();
    if (this.request.signal.aborted) return;
    this.clearPendingChange();
    this.actionState.set('idle');
    this.changeReference.set(undefined);
    this.retryAfterNotFound.set(false);
    if (result.kind === 'access_changed') {
      this.clearForAccessChange(result.status);
      return;
    }
    this.acceptRead(result);
    this.focusHeadingSoon();
  }

  private async readAfterConfirmedChange(): Promise<void> {
    const result = await this.readGroupOnce();
    if (this.request.signal.aborted) return;
    if (result.kind === 'access_changed') {
      this.clearForAccessChange(result.status);
      return;
    }
    if (result.kind !== 'ok' || !result.value) {
      this.membersUnavailable.set(true);
      this.pendingChange.set(undefined);
      this.reviewMember.set(undefined);
      this.focusHeadingSoon();
      return;
    }
    this.acceptGroup(result.value);
    this.membersUnavailable.set(false);
    this.retryAfterNotFound.set(false);
    this.pendingChange.set(undefined);
    this.reviewMember.set(undefined);
    this.focusHeadingSoon();
  }

  private async readGroupOnce(): Promise<Outcome<GroupRow | undefined>> {
    if (this.readInFlight) return { kind: 'unavailable' };
    this.readInFlight = true;
    const result = await fetchGroup(this.groupId(), this.request.signal);
    this.readInFlight = false;
    return result;
  }

  private acceptRead(result: Outcome<GroupRow | undefined>): void {
    if (result.kind === 'ok') {
      if (!result.value) {
        this.group.set(undefined);
        this.state.set('missing');
        this.statusKind.set('removed');
        this.statusMessage.set("This group doesn't exist or is no longer available.");
        return;
      }
      this.acceptGroup(result.value);
      this.statusMessage.set('Group loaded');
      return;
    }
    if (result.kind === 'access_changed') {
      this.clearForAccessChange(result.status);
      return;
    }
    this.group.set(undefined);
    this.state.set('failed');
    this.statusKind.set('failed');
    this.statusMessage.set('Groups are unavailable right now');
    this.detail.set('Nothing changed. Reading again is safe.');
  }

  private acceptGroup(group: GroupRow | undefined): void {
    if (!group) {
      this.group.set(undefined);
      this.state.set('missing');
      return;
    }
    this.group.set(group);
    this.state.set('ready');
  }

  private clearPendingChange(): void {
    this.pendingChange.set(undefined);
    this.receiptSeen = false;
    this.reviewMember.set(undefined);
    this.draftCommand = undefined;
  }

  private groupName(): string {
    return this.group()?.name ?? 'the group';
  }

  protected changesBlocked(): boolean {
    return !!this.pendingChange() || this.actionState() === 'conflict'
      || this.actionState() === 'refused';
  }

  protected clearForAccessChange(status?: number): void {
    // Clear protected names and command references before a late reply can draw them again.
    this.request.abort();
    this.group.set(undefined);
    this.reviewMember.set(undefined);
    this.draftCommand = undefined;
    this.pendingChange.set(undefined);
    this.changeReference.set(undefined);
    this.reviewOpen.set(false);
    this.addOpen.set(false);
    this.membersUnavailable.set(false);
    this.state.set('access');
    this.actionState.set('idle');
    this.statusKind.set('access_changed');
    this.statusMessage.set('Your access changed');
    this.detail.set(status === 401
      ? 'Group details were cleared. Your session ended. Sign in again to continue.'
      : 'Group details were cleared. Managing groups needs the Owner or Admin role.');
  }

  private focusHeading(): void {
    this.headingElement()?.nativeElement.focus();
  }

  private focusHeadingSoon(): void {
    if (this.focusTimer !== undefined) globalThis.clearTimeout(this.focusTimer);
    this.focusTimer = globalThis.setTimeout(this.focusHeading.bind(this), 0);
  }
}

function checkingRemovalMessage(displayName: string, groupName: string): string {
  return `Checking the removal for ${displayName} from ${groupName}…`;
}
