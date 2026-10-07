import {
  ChangeDetectionStrategy,
  Component,
  input,
  signal,
  type OnDestroy,
  type OnInit,
} from '@angular/core';
import type { OwnershipChange, OwnershipOwner, OwnershipResponse } from '@opencrane/protocol';
import { SharedState } from '../shared-state/shared-state';
import { ModalSheet } from '../ui/modal-sheet';
import { fetchOwnership, fetchOwnershipChange, sendOwnershipCommand } from './ownership-api';
import { ownershipOwnerSummary, ownershipRecordedAt,
  transferSuccessMessage } from './ownership-screen-view';

type ScreenState = 'loading' | 'ready' | 'failed' | 'access';
type ReviewKind = 'transfer_entry' | 'transfer_review' | 'step_down' | undefined;
type PendingOwnershipChange = {
  commandId: string;
  action: 'transfer' | 'step_down';
  successorId: string | undefined;
  expectedSequence: number;
  receiptSeen: boolean;
};

@Component({
  selector: 'oc-ownership-screen',
  imports: [SharedState, ModalSheet],
  templateUrl: './ownership-screen.html',
  styleUrl: './ownership-screen.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OwnershipScreen implements OnInit, OnDestroy {
  readonly organisationName = input.required<string>();
  protected readonly state = signal<ScreenState>('loading');
  protected readonly owners = signal<OwnershipOwner[]>([]);
  protected readonly viewer = signal<OwnershipResponse['viewer'] | undefined>(undefined);
  protected readonly sequence = signal(0);
  protected readonly ownershipReady = signal(false);
  protected readonly review = signal<ReviewKind>(undefined);
  protected readonly successorId = signal('');
  protected readonly statusKind = signal<'none' | 'applying' | 'unknown' | 'confirmed'
    | 'conflict' | 'last_owner' | 'refused'>('none');
  protected readonly statusMessage = signal('');
  protected readonly statusDetail = signal('');
  protected readonly recordedChange = signal<OwnershipChange | undefined>(undefined);
  protected readonly checking = signal(false);
  protected readonly reading = signal(false);
  protected readonly sending = signal(false);
  protected readonly transferError = signal('');
  protected readonly refusedSuccessorId = signal('');
  protected readonly focusTarget = signal<HTMLElement | undefined>(undefined);
  private readonly request = new AbortController();
  private ownershipReadNumber = 0;
  private pendingChange: PendingOwnershipChange | undefined;
  private openedBy: HTMLButtonElement | undefined;

  ngOnInit(): void {
    void this.readOwnership(true);
  }

  ngOnDestroy(): void {
    this.request.abort();
  }

  protected async refresh(): Promise<void> {
    if (!this.canRefreshOwners()) return;
    await this.readOwnership(false);
  }

  protected canRefreshOwners(): boolean {
    if (this.state() === 'access' || this.reading()) return false;
    if (!this.hasPendingChange()) return true;
    return this.statusKind() === 'unknown';
  }

  protected openTransfer(button: HTMLButtonElement): void {
    this.openTransferFor(button, '');
  }

  protected chooseAnotherOwner(button: HTMLButtonElement): void {
    this.openTransferFor(button, this.refusedSuccessorId());
  }

  private openTransferFor(button: HTMLButtonElement, successorId: string): void {
    if (this.hasPendingChange() || !this.canManage()) return;
    this.openedBy = button;
    this.focusTarget.set(button);
    this.successorId.set(successorId);
    this.transferError.set('');
    this.statusKind.set('none');
    this.statusMessage.set('');
    this.statusDetail.set('');
    this.review.set('transfer_entry');
  }

  protected prepareTransfer(): void {
    const successorId = this.successorId().trim();
    if (!this.validMemberId(successorId) || this.hasPendingChange()) return;
    if (this.owners().some(ownerMatchesMemberId(successorId))) {
      this.transferError.set('This person is already an owner. Choose someone else.');
      this.recordedChange.set(undefined);
      this.statusKind.set('conflict');
      this.statusMessage.set('This person is already an owner');
      this.statusDetail.set('Choose an active member who is not already an owner.');
      return;
    }
    this.transferError.set('');
    this.review.set('transfer_review');
    this.focusReviewTitle();
  }

  protected openStepDown(button: HTMLButtonElement): void {
    if (this.hasPendingChange() || !this.canStepDown()) return;
    this.openedBy = button;
    this.focusTarget.set(button);
    this.review.set('step_down');
  }

  protected closeReview(): void {
    if (this.sending()) return;
    this.review.set(undefined);
    this.returnFocus();
  }

  protected successorIdChanged(event: Event): void {
    const inputField = event.target;
    if (!(inputField instanceof HTMLInputElement)) return;
    this.successorId.set(inputField.value);
  }

  protected reviewFromEnter(event: Event): void {
    event.preventDefault();
    this.prepareTransfer();
  }

  protected async confirmTransfer(): Promise<void> {
    const successorId = this.successorId().trim();
    if (!this.validMemberId(successorId) || this.hasPendingChange()) return;
    const pendingChange = this.createPendingChange('transfer', successorId);
    // Close the review before sending so the person cannot confirm the same draft twice.
    this.review.set(undefined);
    await this.sendChange(pendingChange);
  }

  protected async confirmStepDown(): Promise<void> {
    if (!this.canStepDown() || this.hasPendingChange()) return;
    const pendingChange = this.createPendingChange('step_down', undefined);
    this.review.set(undefined);
    await this.sendChange(pendingChange);
  }

  protected async checkStatus(): Promise<void> {
    // Check status is a GET. It must never repeat the ownership command.
    const pendingChange = this.pendingChange;
    if (!pendingChange || this.checking()) return;
    this.checking.set(true);
    const result = await fetchOwnershipChange(pendingChange.commandId, this.request.signal);
    this.checking.set(false);
    if (this.request.signal.aborted || this.pendingChange !== pendingChange) return;
    if (result.kind === 'access_changed') {
      this.clearForAccessChange();
      return;
    }
    if (result.kind !== 'ok') {
      if (result.kind === 'not_found') {
        this.statusKind.set('unknown');
        this.statusMessage.set('The server has no record of this change yet');
        this.statusDetail.set('The first request may still arrive. Check again, or reload to see ' +
          'the current owners before sending anything again.');
        return;
      }
      if (pendingChange.receiptSeen) {
        this.statusKind.set('applying');
        this.statusMessage.set('The change was recorded, but its status is unavailable');
        this.statusDetail.set('Check status again before starting another ownership change.');
        return;
      }
      this.statusKind.set('unknown');
      this.statusMessage.set('We could not tell whether this change was recorded');
      this.statusDetail.set(this.unknownDetail());
      return;
    }
    // Keep the confirmed command receipt separate from later status-read failures.
    pendingChange.receiptSeen = true;
    this.recordedChange.set(result.value);
    const projection = result.value.projection;
    if (projection?.content !== 'current' || projection.iam !== 'current') {
      this.statusKind.set('applying');
      this.statusMessage.set('The change was recorded. Waiting for ownership records to update.');
      this.statusDetail.set('Check status again to see when both records are current.');
      return;
    }
    await this.confirmFromReceipt(pendingChange, result.value);
  }

  protected canManage(): boolean {
    return this.ownershipReady() && this.viewer()?.role === 'owner';
  }

  protected canStepDown(): boolean {
    return this.canManage() && this.owners().length > 1 && !this.hasPendingChange();
  }

  protected hasPendingChange(): boolean {
    return this.pendingChange !== undefined;
  }

  protected validMemberId(memberId: string): boolean {
    return /^[\w-]{1,200}$/u.test(memberId);
  }

  protected showInvalidMemberId(): boolean {
    const memberId = this.successorId().trim();
    return memberId.length > 0 && !this.validMemberId(memberId);
  }

  protected ownerMatchesViewer(owner: OwnershipOwner): boolean {
    return owner.memberId === this.viewer()?.memberId;
  }

  protected pendingReference(): string {
    return this.pendingChange?.commandId ?? '';
  }

  protected reviewTitle(): string {
    if (this.review() === 'transfer_entry') return 'Appoint an owner';
    if (this.review() === 'transfer_review') return 'Review successor';
    if (this.review() === 'step_down') return 'Step down as owner?';
    return 'Review ownership change';
  }

  protected reviewDescription(): string {
    if (this.review() === 'transfer_review') {
      return `Appoint ${this.successorId().trim()} as an owner?`;
    }
    return '';
  }

  protected ownerNames(): string {
    const names: string[] = [];
    for (const owner of this.owners()) names.push(owner.displayName);
    return names.join(' and ');
  }

  protected otherOwnerSummary(): string {
    const names: string[] = [];
    for (const owner of this.owners()) {
      if (!this.ownerMatchesViewer(owner)) names.push(owner.displayName);
    }
    if (names.length === 1) return `${names[0]} stays an Owner`;
    return `${names.join(' and ')} remain Owners`;
  }

  protected backToTransferEntry(): void {
    this.review.set('transfer_entry');
    this.transferError.set('');
    this.focusReviewTitle();
  }

  protected stateMark(): string {
    if (this.statusKind() === 'confirmed') return '✓';
    if (this.statusKind() === 'refused') return '×';
    return '!';
  }

  protected transferSuccessMessage(): string {
    return transferSuccessMessage(this.recordedChange(), this.owners());
  }

  protected formattedRecordedAt(change: OwnershipChange | undefined): string {
    return ownershipRecordedAt(change);
  }

  protected ownerSummary(): string {
    return ownershipOwnerSummary(this.organisationName(), this.ownershipReady(),
      this.owners().length);
  }

  private createPendingChange(
    action: PendingOwnershipChange['action'],
    successorId: string | undefined,
  ): PendingOwnershipChange {
    const pendingChange: PendingOwnershipChange = {
      commandId: crypto.randomUUID(),
      action,
      successorId,
      expectedSequence: this.sequence(),
      receiptSeen: false,
    };
    this.pendingChange = pendingChange;
    this.refusedSuccessorId.set('');
    // Keep this record until a current status read and owner list prove the change is complete.
    this.recordedChange.set(undefined);
    this.statusKind.set('none');
    this.statusMessage.set('');
    this.statusDetail.set('');
    return pendingChange;
  }

  private async sendChange(pendingChange: PendingOwnershipChange): Promise<void> {
    this.sending.set(true);
    const command = this.commandFor(pendingChange);
    const result = await sendOwnershipCommand(command, this.request.signal);
    this.sending.set(false);
    if (this.request.signal.aborted || this.pendingChange !== pendingChange) return;
    if (result.kind === 'access_changed') {
      this.clearForAccessChange();
      return;
    }
    if (result.kind === 'last_owner') {
      this.pendingChange = undefined;
      this.statusKind.set('last_owner');
      this.statusMessage.set('You are the last owner');
      this.statusDetail.set('Appoint another owner before stepping down.');
      return;
    }
    if (result.kind === 'conflict') {
      this.pendingChange = undefined;
      this.statusKind.set('conflict');
      this.setConflictMessage(result.reason);
      return;
    }
    if (result.kind === 'refused') {
      this.pendingChange = undefined;
      await this.showRefusal(result.reason, pendingChange);
      return;
    }
    if (result.kind === 'invalid') {
      this.pendingChange = undefined;
      this.statusKind.set('refused');
      this.statusMessage.set('The ownership change was not sent');
      this.statusDetail.set('Nothing was recorded. Check the details and try again.');
      return;
    }
    if (result.kind !== 'ok') {
      this.showUnknownResult();
      return;
    }
    pendingChange.receiptSeen = true;
    this.recordedChange.set(result.value);
    this.statusKind.set('applying');
    this.statusMessage.set('The change was recorded. Waiting for ownership records to update.');
    this.statusDetail.set('Check status to read the original change. This will not send it again.');
    await this.checkStatus();
  }

  private commandFor(pendingChange: PendingOwnershipChange) {
    if (pendingChange.action === 'transfer') {
      return {
        action: 'transfer' as const,
        commandId: pendingChange.commandId,
        expectedSequence: pendingChange.expectedSequence,
        successorId: pendingChange.successorId ?? '',
      };
    }
    return {
      action: 'step_down' as const,
      commandId: pendingChange.commandId,
      expectedSequence: pendingChange.expectedSequence,
    };
  }

  private async confirmFromReceipt(
    pendingChange: PendingOwnershipChange,
    change: OwnershipChange,
  ): Promise<void> {
    this.ownershipReadNumber += 1;
    const readNumber = this.ownershipReadNumber;
    const result = await fetchOwnership(this.request.signal);
    if (this.request.signal.aborted || this.pendingChange !== pendingChange ||
        readNumber !== this.ownershipReadNumber) return;
    if (result.kind === 'access_changed') {
      this.clearForAccessChange();
      return;
    }
    if (result.kind !== 'ok') {
      this.statusKind.set('applying');
      this.statusMessage.set('The change was recorded, but the owner list is not available yet');
      this.statusDetail.set('Check status again before starting another ownership change.');
      return;
    }
    this.applyOwnership(result.value);
    this.statusKind.set('confirmed');
    this.recordedChange.set(change);
    if (pendingChange.action === 'transfer') {
      this.statusMessage.set(this.transferSuccessMessage());
      this.statusDetail.set('You remain an owner.');
      this.moveFocusToOpenedAction();
    } else {
      this.statusMessage.set('You are now an Admin');
      this.statusDetail.set('Another owner remains in place.');
      this.moveFocusToOwnersHeading();
    }
    this.pendingChange = undefined;
  }

  private async readOwnership(initialLoad: boolean): Promise<void> {
    this.ownershipReadNumber += 1;
    const readNumber = this.ownershipReadNumber;
    const retryingFailedRead = this.state() === 'failed';
    this.reading.set(true);
    const result = await fetchOwnership(this.request.signal);
    this.reading.set(false);
    if (this.request.signal.aborted || readNumber !== this.ownershipReadNumber) return;
    if (result.kind === 'access_changed') {
      this.clearForAccessChange();
      return;
    }
    if (result.kind !== 'ok') {
      this.state.set('failed');
      if (initialLoad || this.statusKind() === 'none') {
        this.statusMessage.set('Owners are unavailable right now');
      }
      return;
    }
    this.applyOwnership(result.value);
    this.state.set('ready');
    if (retryingFailedRead && document.activeElement instanceof HTMLButtonElement) {
      document.getElementById('ownership-heading')?.focus();
      this.statusMessage.set('Owners loaded');
    }
    if (!initialLoad && (this.statusKind() === 'conflict' ||
        this.statusKind() === 'last_owner')) {
      this.statusKind.set('none');
    }
  }

  private applyOwnership(response: OwnershipResponse): void {
    this.owners.set(response.owners);
    this.viewer.set(response.viewer);
    this.sequence.set(response.sequence);
    this.ownershipReady.set(response.ready);
  }

  private showUnknownResult(): void {
    this.statusKind.set('unknown');
    this.statusMessage.set('We could not tell whether this change was recorded');
    this.statusDetail.set(this.unknownDetail());
  }

  private setConflictMessage(reason: string | undefined): void {
    if (reason === 'already_owner') {
      this.statusMessage.set('This person is already an owner');
      this.statusDetail.set('Refresh the owner list before choosing someone else.');
      return;
    }
    if (reason === 'command_id_reused') {
      this.statusMessage.set('This change reference has already been used');
      this.statusDetail.set('No new change was recorded. Refresh the owner list before trying again.');
      return;
    }
    this.statusMessage.set('Another ownership change happened first');
    this.statusDetail.set('Refresh the owner list and review the change again.');
  }

  private focusReviewTitle(): void {
    globalThis.setTimeout(focusDialogTitle, 0);
  }

  private unknownDetail(): string {
    const successorId = this.pendingChange?.successorId;
    if (successorId) {
      return `The change for member id ${successorId} may or may not have been recorded. ` +
        'Check its status before sending another change.';
    }
    return 'The ownership change may or may not have been recorded. ' +
      'Check its status before sending another change.';
  }

  private async showRefusal(
    reason: string | undefined,
    pendingChange: PendingOwnershipChange,
  ): Promise<void> {
    this.refusedSuccessorId.set('');
    if (reason === 'access_changed' || reason === 'owner_or_admin_required' ||
        reason === 'active_membership_required') {
      this.clearForAccessChange();
      return;
    }
    this.statusKind.set('refused');
    if (reason === 'active_successor_required') {
      const successorId = pendingChange.successorId ?? 'This person';
      this.refusedSuccessorId.set(successorId);
      this.statusMessage.set(`${successorId} is not an active member`);
      this.statusDetail.set('Only an active member can become an owner. No change was recorded.');
      return;
    }
    if (reason === 'owner_required') {
      this.statusMessage.set('You are no longer an owner');
      this.statusDetail.set('The page is checking your current role before showing owner controls.');
      this.owners.set([]);
      this.viewer.set(undefined);
      this.ownershipReady.set(false);
      await this.readOwnership(false);
      if (this.state() === 'ready' && this.viewer()?.role === 'admin') {
        this.statusDetail.set('The owner list shows your Admin role. Admins cannot change owners.');
      }
      this.moveFocusToOwnersHeading();
      return;
    }
    this.statusMessage.set('The server refused this ownership change');
    this.statusDetail.set('No ownership change was recorded.');
  }

  private clearForAccessChange(): void {
    this.ownershipReadNumber += 1;
    this.owners.set([]);
    this.viewer.set(undefined);
    this.ownershipReady.set(false);
    this.recordedChange.set(undefined);
    this.pendingChange = undefined;
    this.review.set(undefined);
    this.state.set('access');
    this.statusMessage.set('Your access changed');
    this.statusDetail.set('Sign in again, or ask an Owner to restore your access.');
  }

  private returnFocus(): void {
    const target = this.openedBy;
    this.openedBy = undefined;
    if (target?.isConnected) target.focus();
  }

  private moveFocusToOwnersHeading(): void {
    this.openedBy = undefined;
    this.focusTarget.set(undefined);
    globalThis.setTimeout(this.focusOwnersHeading.bind(this), 50);
  }

  private moveFocusToOpenedAction(): void {
    globalThis.setTimeout(this.focusAppointmentButton.bind(this), 50);
  }

  private focusAppointmentButton(): void {
    const button = document.getElementById('appoint-owner');
    button?.focus();
  }

  private focusOwnersHeading(): void {
    const heading = document.getElementById('ownership-heading');
    heading?.focus();
  }
}

function ownerMatchesMemberId(memberId: string): (owner: OwnershipOwner) => boolean {
  return (owner) => owner.memberId === memberId;
}

function focusDialogTitle(): void {
  document.querySelector<HTMLDialogElement>('dialog[open] h2')?.focus();
}
