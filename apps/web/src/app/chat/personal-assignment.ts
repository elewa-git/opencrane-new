import { effect, signal, type WritableSignal } from '@angular/core';
import type { ChatContext, MemoryAdmission, ServerMessage } from '@opencrane/protocol';
import type { WebSocketService } from '../core/websocket.service';

export interface AssignmentState {
  memberId: WritableSignal<string>;
  assistantId: WritableSignal<string | null>;
  role: WritableSignal<ChatContext['role']>;
  personalConnections: WritableSignal<boolean>;
  memoryAdmission: WritableSignal<MemoryAdmission>;
  selected: WritableSignal<string>;
}

export class PersonalAssignment {
  private readonly watching = signal(false);
  private readonly subscription;
  private readonly socket: WebSocketService;
  private readonly state: AssignmentState;

  constructor(socket: WebSocketService, state: AssignmentState) {
    this.socket = socket;
    this.state = state;
    this.subscription = socket.received.subscribe(this.receive.bind(this));
    effect(this.subscribeWhenConnected.bind(this));
  }

  apply(context: ChatContext): void {
    this.state.memberId.set(context.memberId);
    this.state.role.set(context.role);
    this.state.assistantId.set(context.assistantId);
    this.state.personalConnections.set(context.personalConnections === true);
    if (context.memoryAdmission) this.state.memoryAdmission.set(context.memoryAdmission);
  }

  watch(): void {
    if (this.state.assistantId() || !this.state.memberId()) return;
    this.watching.set(true);
    this.socket.connect();
  }

  openDraft(): void {
    this.socket.disconnect();
    this.watch();
  }

  destroy(): void {
    this.watching.set(false);
    this.subscription.unsubscribe();
  }

  private subscribeWhenConnected(): void {
    if (!this.watching()) return;
    if (this.state.selected()) {
      this.watching.set(false);
      return;
    }
    if (this.socket.state() !== 'open') return;
    this.socket.send({ type: 'subscribe', topic: 'chat-context' });
  }

  private receive(message: ServerMessage): void {
    if (!this.watching() || message.type !== 'context') return;
    if (message.data.memberId !== this.state.memberId()) return;
    this.apply(message.data);
    if (!message.data.assistantId) return;
    this.watching.set(false);
    this.socket.disconnect();
  }
}
