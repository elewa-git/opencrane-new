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

type ScreenState = 'loading' | 'ready' | 'failed' | 'access';
type ReviewKind = 'transfer_entry' | 'transfer_review' | undefined;
type PendingOwnershipChange = {
  commandId: string;
  action: 'transfer';
  successorId: string;
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
    | 'conflict' | 'refused'>('none');
  protected readonly statusMessage = signal('');
  protected readonly statusDetail = signal('');
  protected readonly recordedChange = signal<OwnershipChange | undefined>(undefined);
  protected readonly checking = signal(false);
  protected readonly reading = signal(false);
  protected readonly sending = signal(false);
  protected readonly transferError = signal('');
  protected readonly focusTarget = signal<HTMLElement | undefined>(undefined);
  private readonly request = new AbortController();
  private pendingChange: PendingOwnershipChange | undefined;
  private openedBy: HTMLButtonElement | undefined;

  ngOnInit(): void {
    void this.readOwnership(true);
  }

  ngOnDestroy(): void {
    this.request.abort();
  }

  protected async refresh(): Promise<void> {
    if (this.state() === 'access' || this.reading()) return;
    await this.readOwnership(false);
  }

  protected openTransfer(button: HTMLButtonElement): void {
    if (this.hasPendingChange() || !this.canManage()) return;
    this.openedBy = button;
    this.focusTarget.set(button);
    this.successorId.set('');
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
    const pendingChange = this.createPendingChange(successorId);
    // Close the review before sending so the person cannot confirm the same draft twice.
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

  protected memberIdOf(change: OwnershipChange | undefined): string {
    if (!change || typeof change.data['memberId'] !== 'string') return '';
    return change.data['memberId'];
  }

  protected formattedRecordedAt(change: OwnershipChange | undefined): string {
    if (!change) return '';
    const date = new Date(change.recordedAt);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(date) + ' UTC';
  }

  protected ownerSummary(): string {
    if (!this.ownershipReady()) return `${this.organisationName()} · ownership unavailable`;
    return `${this.organisationName()} · ${this.owners().length} owner${
      this.owners().length === 1 ? '' : 's'}`;
  }

  private createPendingChange(successorId: string): PendingOwnershipChange {
    const pendingChange: PendingOwnershipChange = {
      commandId: crypto.randomUUID(),
      action: 'transfer',
      successorId,
      expectedSequence: this.sequence(),
      receiptSeen: false,
    };
    this.pendingChange = pendingChange;
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
    if (result.kind === 'conflict') {
      this.pendingChange = undefined;
      this.statusKind.set('conflict');
      this.statusMessage.set('Another ownership change happened first');
      this.statusDetail.set('Refresh the owner list and review the change again.');
      return;
    }
    if (result.kind === 'refused') {
      this.pendingChange = undefined;
      this.showRefusal();
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
    return {
      action: 'transfer' as const,
      commandId: pendingChange.commandId,
      expectedSequence: pendingChange.expectedSequence,
      successorId: pendingChange.successorId,
    };
  }

  private async confirmFromReceipt(
    pendingChange: PendingOwnershipChange,
    change: OwnershipChange,
  ): Promise<void> {
    const result = await fetchOwnership(this.request.signal);
    if (this.request.signal.aborted || this.pendingChange !== pendingChange) return;
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
    this.statusMessage.set(`${pendingChange.successorId} is now an owner`);
    this.statusDetail.set('You remain an owner.');
    this.moveFocusToOpenedAction();
    this.pendingChange = undefined;
  }

  private async readOwnership(initialLoad: boolean): Promise<void> {
    const retryingFailedRead = this.state() === 'failed';
    this.reading.set(true);
    const result = await fetchOwnership(this.request.signal);
    this.reading.set(false);
    if (this.request.signal.aborted) return;
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
    if (!initialLoad && this.statusKind() === 'conflict') {
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

  private showRefusal(): void {
    this.statusKind.set('refused');
    this.statusMessage.set('The server refused this ownership change');
    this.statusDetail.set('No ownership change was recorded.');
  }

  private clearForAccessChange(): void {
    this.owners.set([]);
    this.viewer.set(undefined);
    this.ownershipReady.set(false);
    this.recordedChange.set(undefined);
    this.pendingChange = undefined;
    this.review.set(undefined);
    this.state.set('access');
    this.statusMessage.set('Your access changed');
    this.statusDetail.set('Owner details have been cleared.');
  }

  private returnFocus(): void {
    const target = this.openedBy;
    this.openedBy = undefined;
    if (target?.isConnected) target.focus();
  }

  private moveFocusToOpenedAction(): void {
    globalThis.setTimeout(this.focusAppointmentButton.bind(this), 50);
  }

  private focusAppointmentButton(): void {
    const button = document.getElementById('appoint-owner');
    button?.focus();
  }

}

function ownerMatchesMemberId(memberId: string): (owner: OwnershipOwner) => boolean {
  return (owner) => owner.memberId === memberId;
}

function focusDialogTitle(): void {
  document.querySelector<HTMLDialogElement>('dialog[open] h2')?.focus();
}
