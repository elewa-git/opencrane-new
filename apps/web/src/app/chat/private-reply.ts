import { inject, signal } from '@angular/core';
import type { ServerMessage, ChatRow, ChatConversation } from '@opencrane/protocol';

import { WebSocketService } from '../core/websocket.service';

interface PersonalSession {
  selectedConversation(): ChatConversation | undefined;
  memberId(): string;
  assistantId(): string | null;
  denied(): boolean;
}

type PrivateFrame = Extract<ServerMessage, { type: 'private_reply' | 'private_output_cleared' }>;
type Reply = Extract<PrivateFrame, { type: 'private_reply' }>;

function sameIdentity(first: PrivateFrame, second: PrivateFrame): boolean {
  return first.conversationId === second.conversationId && first.turnId === second.turnId
    && first.threadId === second.threadId && first.generation === second.generation
    && first.inputGeneration === second.inputGeneration;
}

export class PrivateReplyState {
  private readonly socket = inject(WebSocketService);
  private readonly privateSubscription = this.socket.privateReceived.subscribe(this.receive.bind(this));
  private readonly closeSubscription = this.socket.connectionClosed.subscribe(this.disconnected.bind(this));
  private readonly feedSubscription = this.socket.received.subscribe(this.feedMessage.bind(this));
  private readonly value = signal<Reply | null>(null);
  readonly reply = this.value.asReadonly();
  readonly unavailableTurnId = signal('');
  private turnId = '';
  private ready = false;
  private projectionGeneration: number | undefined;
  private accepting = false;
  private identity: PrivateFrame | null = null;

  private readonly session: PersonalSession;

  constructor(session: PersonalSession) {
    this.session = session;
  }

  destroy(): void {
    this.clear();
    this.privateSubscription.unsubscribe();
    this.closeSubscription.unsubscribe();
    this.feedSubscription.unsubscribe();
  }

  private disconnected(): void {
    this.ready = false;
    this.clear();
  }

  private feedMessage(message: ServerMessage): void {
    if (!('conversationId' in message)) return;
    if (message.conversationId !== this.session.selectedConversation()?.conversationId) return;
    if (!('position' in message)) return;
    this.checkProjection(message.generation);
    if (message.type === 'ready') this.ready = true;
  }

  private isCurrentPersonalSession(frame: PrivateFrame): boolean {
    const conversation = this.session.selectedConversation();
    if (this.session.denied() || !this.socket.isConnected()) return false;
    if (conversation?.mode !== 'agent_session' || conversation.assistantKind === 'team') return false;
    if (conversation.conversationId !== frame.conversationId) return false;
    if (conversation.assistantId !== this.session.assistantId()) return false;
    return conversation.createdBy === this.session.memberId();
  }

  checkProjection(generation: number): void {
    if (this.projectionGeneration !== undefined && generation !== this.projectionGeneration) {
      this.disconnected();
    }
    this.projectionGeneration = generation;
  }

  private receive(frame: PrivateFrame): void {
    if (!this.isCurrentPersonalSession(frame)) return;
    if (frame.turnId !== this.turnId) return;
    if (this.identity && !sameIdentity(this.identity, frame)) return;
    if (frame.type === 'private_output_cleared') {
      this.unavailableTurnId.set(frame.turnId);
      this.clear();
      return;
    }
    if (!this.accepting || this.identity || frame.data.turnId !== frame.turnId) return;
    // Trust the checked server frame for thread and input identity; history omits them.
    const { data: _data, ...identity } = frame;
    this.identity = { ...identity, type: 'private_output_cleared' };
    this.value.set(frame);
  }

  apply(row: ChatRow, liveStart: boolean): void {
    if (row.type === 'conversation.closed') {
      this.clear();
      return;
    }
    const turnId = row.data.turnId;
    if (row.type === 'agent.turn_started' && turnId && turnId !== this.turnId) {
      this.clear();
      this.turnId = turnId;
      this.accepting = liveStart && this.ready;
    }
    if (turnId !== this.turnId) return;
    if (row.type === 'agent.turn_completed') this.accepting = false;
    if (row.type === 'agent.turn_failed' || row.type === 'agent.turn_stop_requested') this.clear();
  }

  clear(): void {
    const reply = this.value();
    if (reply) this.unavailableTurnId.set(reply.turnId);
    this.value.set(null);
    this.identity = null;
    this.accepting = false;
  }
}
