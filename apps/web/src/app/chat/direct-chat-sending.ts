import { computed, signal, type WritableSignal } from '@angular/core';
import type { Colleague, ReviewedSnapshot } from './recipient-picker';
import { newDirectCommandId } from './direct-chat-address';
import {
  checkDirectChange, createDirectChat, fetchDirectHistory, sendDirectMessage, type DirectFailure,
} from './direct-chat-api';

type SendState = 'idle' | 'applying' | 'unknown' | 'failed';
type PendingChange = {
  phase: 'creating' | 'access' | 'sending';
  state: 'applying' | 'unknown' | 'not_found';
  checking: boolean;
  issue?: 'unavailable' | 'access_applying';
  commandId: string;
  messageId: string;
  conversationId: string;
  text: string;
  colleagueId: string;
  participantIds?: string[];
  groupId?: string;
  groupSnapshotPosition?: number;
};

type DirectSendScreen = {
  draft: WritableSignal<string>;
  status: WritableSignal<string>;
  signal: AbortSignal;
  created(conversationId: string): void;
  confirmed(conversationId: string): Promise<void>;
  accessChanged(): void;
};

type RecipientSend = {
  busy: boolean;
  ready: boolean;
  recipient: Colleague | undefined;
  people: Colleague[];
  snapshot: ReviewedSnapshot | undefined;
  memberId: string;
  conversationId: string;
  isExisting: boolean;
  text: string;
};

// Keep creation and its first message together until the message has a receipt.
export class DirectChatSending {
  readonly pending = signal<PendingChange | undefined>(undefined);
  readonly failure = signal('');
  readonly recordedMessage = signal('');
  readonly state = computed<SendState>(this.currentSendState.bind(this));
  readonly checking = computed(this.isStatusChecking.bind(this));
  readonly busy = computed(this.isBusy.bind(this));

  private readonly screen: DirectSendScreen;

  constructor(screen: DirectSendScreen) {
    this.screen = screen;
  }

  reset(): void {
    this.pending.set(undefined);
    this.failure.set('');
    this.recordedMessage.set('');
  }

  async checkStatus(): Promise<void> {
    const pending = this.pending();
    if (!pending || pending.state === 'applying' || pending.checking) return;
    const checking = { ...pending, checking: true };
    this.pending.set(checking);
    this.screen.status.set('Checking the original change status…');
    if (pending.phase === 'access') {
      await this.checkApplyingAccess(checking);
      return;
    }
    const result = await checkDirectChange(
      pending.conversationId, pending.commandId, this.screen.signal,
    );
    if (!this.isPending(checking)) return;
    const checked = { ...checking, checking: false };
    this.pending.set(checked);
    // A create with no server record gets the same refusal as a guessed conversation id.
    if (pending.phase === 'creating' && 'status' in result && result.status === 403) {
      this.markNoRecord(checked);
      return;
    }
    if (result.kind === 'not_found') {
      this.markNoRecord(checked);
      return;
    }
    if (result.kind === 'access_changed') {
      this.screen.accessChanged();
      return;
    }
    if (result.kind !== 'ok') {
      this.screen.status.set('We still cannot confirm this change. Check its status again.');
      return;
    }
    const expectedType = pending.phase === 'creating' ? 'conversation.created' : 'message.posted';
    if (result.value.type !== expectedType) {
      this.screen.status.set('We still cannot confirm this change. Check its status again.');
      return;
    }
    await this.confirmPending(checked);
  }

  async retryPending(): Promise<void> {
    const pending = this.pending();
    if (!pending || pending.state !== 'not_found' || pending.checking) return;
    const applying: PendingChange = { ...pending, state: 'applying' };
    this.pending.set(applying);
    if (applying.phase === 'access') {
      await this.finishCreation(applying);
      return;
    }
    await this.sendPending(applying);
  }

  private markNoRecord(pending: PendingChange): void {
    const missing: PendingChange = { ...pending, state: 'not_found', checking: false };
    this.pending.set(missing);
    this.screen.status.set(this.unknownMessage());
  }


  unknownMessage(): string {
    const pending = this.pending();
    if (pending?.phase === 'access') {
      if (pending.state === 'not_found') {
        return 'Permissions are ready. Your message has not been sent. Send again to continue.';
      }
      if (pending.issue !== 'access_applying') {
        return 'Could not check the new chat’s permissions. Your message is kept. Check status again.';
      }
      return 'Permissions are still being applied. Your message is kept. Check status to try again.';
    }
    if (pending?.state === 'not_found') {
      if (pending.phase === 'creating') {
        return 'The chat was not created: no record is available. Your message is kept. Try again.';
      }
      return 'No record of this message yet. It may still arrive.';
    }
    if (pending?.phase === 'creating') {
      return "We couldn't tell whether the conversation started. Check its status before sending again.";
    }
    return "We couldn't tell whether the message was recorded. Check its status before sending again.";
  }

  applyingMessage(): string {
    if (this.pending()?.phase === 'sending') return 'Sending message…';
    return 'Starting the conversation…';
  }


  async createConversation(
    conversationId: string, colleagueId: string, text: string,
  ): Promise<void> {
    const pending: PendingChange = {
      phase: 'creating', state: 'applying', checking: false,
      commandId: newDirectCommandId('create'), messageId: newDirectCommandId('message'),
      conversationId, text, colleagueId,
    };
    this.pending.set(pending);
    this.failure.set('');
    await this.sendPending(pending);
  }

  async createGroupConversation(
    conversationId: string,
    participantIds: string[],
    text: string,
    groupId?: string,
    groupSnapshotPosition?: number,
  ): Promise<void> {
    const pending: PendingChange = {
      phase: 'creating', state: 'applying', checking: false,
      commandId: newDirectCommandId('create'), messageId: newDirectCommandId('message'),
      conversationId, text, colleagueId: '', participantIds,
      ...(groupId ? { groupId } : {}),
      ...(groupSnapshotPosition === undefined ? {} : { groupSnapshotPosition }),
    };
    this.pending.set(pending);
    this.failure.set('');
    await this.sendPending(pending);
  }

  async sendToRecipients(input: RecipientSend): Promise<void> {
    if (input.busy || !input.ready || !input.text.trim()) return;
    if (!input.recipient && input.people.length === 0) return;
    if (input.isExisting) {
      if (input.recipient) {
        await this.postMessage(input.conversationId, input.text, input.recipient.memberId);
      }
      return;
    }
    const participantIds = uniqueMemberIds(input.memberId, input.people);
    if (participantIds.length > 97) return;
    if (input.snapshot || input.people.length > 1) {
      await this.createGroupConversation(
        input.conversationId,
        participantIds,
        input.text,
        input.snapshot?.groupId,
        input.snapshot?.position,
      );
      return;
    }
    if (input.recipient) {
      await this.createConversation(input.conversationId, input.recipient.memberId, input.text);
    }
  }

  async postMessage(
    conversationId: string, text: string, colleagueId: string,
  ): Promise<void> {
    const commandId = newDirectCommandId('message');
    const pending: PendingChange = {
      phase: 'sending', state: 'applying', checking: false,
      commandId, messageId: commandId, conversationId, text, colleagueId,
    };
    this.pending.set(pending);
    this.failure.set('');
    await this.sendPending(pending);
  }

  private async sendPending(pending: PendingChange): Promise<void> {
    this.screen.status.set(this.applyingMessage());
    let result;
    if (pending.phase === 'creating') {
      const body = this.creationBody(pending);
      result = await createDirectChat(body, this.screen.signal);
    } else {
      result = await this.sendWithAccessRetry(pending);
    }
    if (!this.isPending(pending)) return;
    if (result.kind === 'ok') {
      await this.confirmPending(pending);
      return;
    }
    this.handleWriteFailure(result.kind, pending);
  }

  private creationBody(pending: PendingChange) {
    if (pending.participantIds) {
      return {
        id: pending.commandId,
        conversationId: pending.conversationId,
        mode: 'group' as const,
        participantIds: pending.participantIds,
        ...(pending.groupId ? { groupId: pending.groupId } : {}),
        ...(pending.groupSnapshotPosition === undefined ? {}
          : { groupSnapshotPosition: pending.groupSnapshotPosition }),
      };
    }
    return {
      id: pending.commandId, conversationId: pending.conversationId,
      mode: 'direct' as const, colleagueId: pending.colleagueId,
    };
  }

  private async confirmPending(pending: PendingChange): Promise<void> {
    if (pending.phase === 'creating') {
      const applying: PendingChange = { ...pending, phase: 'access', state: 'applying' };
      // Keep this record and its text until the first message itself has a receipt.
      this.pending.set(applying);
      this.screen.created(pending.conversationId);
      await this.finishCreation(applying);
      return;
    }
    // Keep an edit that arrived after submission; it was not part of this command.
    if (this.screen.draft() === pending.text) this.screen.draft.set('');
    this.pending.set(undefined);
    this.failure.set('');
    this.recordedMessage.set(pending.commandId);
    this.screen.status.set('Message recorded.');
    await this.screen.confirmed(pending.conversationId);
  }

  private async checkApplyingAccess(pending: PendingChange): Promise<void> {
    const result = await this.waitForCreationAccess(pending);
    if (!this.isPending(pending)) return;
    if (result.kind !== 'ok') {
      this.handleWriteFailure(result.kind, pending);
      return;
    }
    const ready: PendingChange = { ...pending, state: 'not_found', checking: false };
    this.pending.set(ready);
    this.screen.status.set(this.unknownMessage());
  }

  private async finishCreation(pending: PendingChange): Promise<void> {
    this.screen.status.set('Starting the conversation…');
    const ready = await this.waitForCreationAccess(pending);
    if (!this.isPending(pending)) return;
    if (ready.kind !== 'ok') {
      this.handleWriteFailure(ready.kind, pending);
      return;
    }
    // Use this read only to check permissions. Load the transcript after the send receipt.
    const sending: PendingChange = {
      ...pending, phase: 'sending', state: 'applying', checking: false,
      commandId: pending.messageId,
    };
    this.pending.set(sending);
    await this.sendPending(sending);
  }

  private async waitForCreationAccess(pending: PendingChange) {
    const delays = [100, 200, 400, 800, 1600, 1600];
    for (const delay of delays) {
      const result = await fetchDirectHistory(pending.conversationId, this.screen.signal);
      if (result.kind !== 'access_applying' || !this.isPending(pending)) return result;
      await this.waitForRetry(delay);
    }
    return { kind: 'access_applying' as const };
  }

  private async sendWithAccessRetry(pending: PendingChange) {
    const delays = [100, 200, 400, 800, 1600, 1600];
    const body = { id: pending.commandId, text: pending.text };
    for (const delay of delays) {
      const result = await sendDirectMessage(pending.conversationId, body, this.screen.signal);
      if (result.kind !== 'access_applying' || !this.isPending(pending)) return result;
      await this.waitForRetry(delay);
    }
    return { kind: 'access_applying' as const };
  }

  private async waitForRetry(delay: number): Promise<void> {
    function wait(resolve: () => void): void {
      setTimeout(resolve, delay);
    }
    await new Promise<void>(wait);
  }

  private isPending(pending: PendingChange): boolean {
    return !this.screen.signal.aborted && this.pending() === pending;
  }

  private handleWriteFailure(kind: DirectFailure, pending: PendingChange): void {
    if (kind === 'access_changed' || (kind === 'refused' && pending.phase === 'access')) {
      this.screen.accessChanged();
      return;
    }
    if (kind === 'unavailable' || kind === 'access_applying') {
      let phase = pending.phase;
      if (kind === 'access_applying') phase = 'access';
      const unknown: PendingChange = { ...pending, phase, state: 'unknown', checking: false, issue: kind };
      this.pending.set(unknown);
      this.screen.status.set(this.unknownMessage());
      return;
    }
    this.pending.set(undefined);
    this.failure.set(this.failureMessage(kind, pending));
    this.screen.status.set(this.failure());
  }


  private failureMessage(kind: DirectFailure, pending: PendingChange): string {
    if (kind === 'conflict') {
      return 'Group membership changed. Choose the group again to review its current members.';
    }
    if (kind === 'refused') return 'You cannot send this message to that person.';
    if (kind === 'invalid') return 'The message could not be accepted.';
    return `The change was not completed. Reference: ${pending.commandId}.`;
  }


  private currentSendState(): SendState {
    const pending = this.pending();
    if (pending?.state === 'applying') return 'applying';
    if (pending) return 'unknown';
    if (this.failure()) return 'failed';
    return 'idle';
  }

  private isStatusChecking(): boolean {
    return this.pending()?.checking ?? false;
  }

  private isBusy(): boolean {
    return Boolean(this.pending());
  }


}

function uniqueMemberIds(memberId: string, people: Colleague[]): string[] {
  const participantIds = [memberId];
  for (const person of people) participantIds.push(person.memberId);
  return [...new Set(participantIds)];
}
