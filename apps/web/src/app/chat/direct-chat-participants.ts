import { signal } from '@angular/core';
import { chatParticipantCommandSchema } from '@opencrane/protocol';
import { z } from 'zod';
import { changeParticipant, checkDirectChange, fetchParticipants } from './direct-chat-api';
import type { Colleague } from './recipient-picker';
import { newDirectCommandId } from './direct-chat-address';

type State = 'closed' | 'loading' | 'ready' | 'applying' | 'unknown' | 'failed';
type Action = z.infer<typeof chatParticipantCommandSchema>['action'];
type Change = { action: 'add' | 'remove'; participantId: string } | { action: 'leave' };

function isColleague(memberId: string, person: Colleague): boolean {
  return person.memberId === memberId;
}

function matchesQuery(person: Colleague, query: string, present: Set<string>): boolean {
  const name = person.displayName ?? person.memberId;
  return !present.has(person.memberId) && name.toLowerCase().includes(query);
}

function memberIdOf(person: { memberId: string }): string {
  return person.memberId;
}

export class DirectChatParticipants {
  readonly state = signal<State>('closed');
  readonly rows = signal<{ memberId: string; displayName: string | null }[]>([]);
  readonly query = signal('');
  readonly notice = signal('');
  readonly commandId = signal('');
  readonly action = signal<Action | ''>('');
  readonly accessPosition = signal(0);
  readonly canManage = signal(false);
  readonly canLeave = signal(false);
  readonly checking = signal(false);
  readonly stale = signal<Colleague | undefined>(undefined);
  private request: AbortController | undefined;
  private readonly conversationId: () => string;
  private readonly colleagues: () => Colleague[];
  private readonly readAllowed: () => boolean;
  private readonly refreshColleagues: () => Promise<void>;
  private readonly accessChanged: () => void;

  constructor(conversationId: () => string, colleagues: () => Colleague[],
    readAllowed: () => boolean, refreshColleagues: () => Promise<void>,
    accessChanged: () => void) {
    this.conversationId = conversationId;
    this.colleagues = colleagues;
    this.readAllowed = readAllowed;
    this.refreshColleagues = refreshColleagues;
    this.accessChanged = accessChanged;
  }

  async open(): Promise<void> {
    if (this.commandId()) {
      this.state.set('unknown');
      this.notice.set('The result is unknown. Check the original change status.');
      return;
    }
    this.state.set('loading');
    this.notice.set('');
    this.stale.set(undefined);
    this.query.set('');
    await this.read();
  }

  close(): void {
    this.state.set('closed');
  }

  reset(): void {
    this.request?.abort();
    this.state.set('closed');
    this.rows.set([]);
    this.commandId.set('');
    this.action.set('');
    this.accessPosition.set(0);
    this.canManage.set(false);
    this.canLeave.set(false);
    this.checking.set(false);
    this.notice.set('');
    this.query.set('');
    this.stale.set(undefined);
  }

  eligible(): Colleague[] {
    const query = this.query().trim().toLowerCase();
    const memberIds = this.rows().map(memberIdOf);
    const present = new Set(memberIds);
    const stale = this.stale();
    if (stale) present.add(stale.memberId);
    function isEligible(person: Colleague): boolean {
      return matchesQuery(person, query, present);
    }
    return this.colleagues().filter(isEligible);
  }

  async add(memberId: string): Promise<void> {
    await this.send({ action: 'add', participantId: memberId });
  }

  async remove(memberId: string): Promise<void> {
    await this.send({ action: 'remove', participantId: memberId });
  }

  async leave(): Promise<void> {
    await this.send({ action: 'leave' });
  }

  async checkStatus(): Promise<void> {
    const commandId = this.commandId();
    const conversationId = this.conversationId();
    if (!commandId || !conversationId || this.checking()) return;
    this.checking.set(true);
    const result = await checkDirectChange(conversationId, commandId, new AbortController().signal);
    this.checking.set(false);
    if (conversationId !== this.conversationId() || !this.readAllowed()) return;
    if (result.kind === 'access_changed') {
      this.accessChanged();
      return;
    }
    if (result.kind !== 'ok') {
      this.state.set('unknown');
      this.notice.set('The result is still unknown. Check this change again.');
      return;
    }
    if (result.value.projection.iam === 'applying'
      || result.value.projection.content === 'applying') {
      this.state.set('applying');
      this.notice.set('Applying participant change…');
      return;
    }
    const wasLeave = this.action() === 'leave';
    this.commandId.set('');
    this.action.set('');
    if (wasLeave) {
      this.accessChanged();
      return;
    }
    this.state.set('ready');
    this.notice.set('Participant change confirmed.');
    await this.read();
  }

  private async read(): Promise<void> {
    const conversationId = this.conversationId();
    if (!conversationId) return;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    const result = await fetchParticipants(conversationId, request.signal);
    if (request.signal.aborted || conversationId !== this.conversationId()
      || !this.readAllowed()) return;
    if (result.kind === 'access_changed') {
      this.accessChanged();
      return;
    }
    if (result.kind !== 'ok') {
      this.state.set('failed');
      this.notice.set('Participants could not be loaded. Try again.');
      return;
    }
    this.rows.set(result.value.rows);
    this.accessPosition.set(result.value.accessPosition);
    this.canManage.set(result.value.canManage);
    this.canLeave.set(result.value.canLeave);
    this.state.set('ready');
  }

  private async send(change: Change): Promise<void> {
    const conversationId = this.conversationId();
    if (!conversationId || this.state() !== 'ready') return;
    const commandId = newDirectCommandId('participant');
    this.commandId.set(commandId);
    this.action.set(change.action);
    this.state.set('applying');
    this.notice.set('Applying participant change…');
    const result = await changeParticipant(conversationId, {
      ...change, id: commandId, expectedAccessPosition: this.accessPosition(),
    }, new AbortController().signal);
    if (conversationId !== this.conversationId() || !this.readAllowed()) return;
    if (result.kind === 'access_changed' && change.action === 'add' && result.status === 403) {
      this.stale.set(this.colleagues().find(isColleague.bind(null, change.participantId)));
      this.commandId.set('');
      this.action.set('');
      await this.read();
      if (this.state() === 'ready' && this.readAllowed()) {
        this.notice.set('That colleague is no longer in the company.');
        await this.refreshColleagues();
      }
      return;
    }
    if (result.kind === 'access_changed') {
      this.accessChanged();
      return;
    }
    if (result.kind === 'unavailable' || result.kind === 'access_applying') {
      this.state.set('unknown');
      this.notice.set('The reply was lost. Check the original change status.');
      return;
    }
    if (result.kind !== 'ok') {
      this.commandId.set('');
      this.action.set('');
      this.state.set('ready');
      this.notice.set('Participants changed. Refresh the list before trying again.');
      if (change.action === 'add') await this.refreshColleagues();
      await this.read();
      return;
    }
    await this.checkStatus();
  }
}
