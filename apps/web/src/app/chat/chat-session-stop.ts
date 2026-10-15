import { signal, type WritableSignal } from '@angular/core';
import type { ChatRow } from '@opencrane/protocol';
import type { Turn } from './chat-state';

export type StopScreen = {
  active(): Turn | undefined;
  busy: WritableSignal<boolean>;
  error: WritableSignal<string>;
  selected(): string;
  revision(): number;
  request(path: string, body: unknown): Promise<unknown>;
  catchUp(conversationId: string, revision: number): Promise<void>;
  recorded(command: { id: string; conversationId: string }): Promise<boolean>;
  fail(error: unknown): void;
};

export class ChatSessionStop {
  readonly stoppingTurnId = signal('');
  private readonly notConfirmedTurnId = signal('');
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private readonly screen: StopScreen;

  constructor(screen: StopScreen) { this.screen = screen; }

  async stop(): Promise<void> {
    const turn = this.screen.active();
    const retrying = turn && this.notConfirmedTurnId() === turn.id;
    if (!turn || turn.state !== 'working' || (this.screen.busy() && !retrying)) return;
    const attempt = ++this.attempt;
    const commandId = `stop-${turn.id}-${crypto.randomUUID()}`;
    this.clearTimer();
    this.stoppingTurnId.set(turn.id);
    this.notConfirmedTurnId.set('');
    this.screen.busy.set(true);
    this.screen.error.set('');
    this.startTimer(turn.id, attempt);
    try {
      await this.screen.request(`/api/conversations/${this.screen.selected()}/messages`, {
        id: commandId, stopTurnId: turn.id,
      });
      if (attempt !== this.attempt) return;
      await this.screen.catchUp(this.screen.selected(), this.screen.revision());
    } catch {
      if (attempt === this.attempt) {
        await this.checkAfterLostReply(turn.id, commandId, attempt);
      }
    } finally {
      if (attempt === this.attempt) this.screen.busy.set(false);
    }
  }

  private async checkAfterLostReply(
    turnId: string, commandId: string, attempt: number,
  ): Promise<void> {
    try {
      const recorded = await this.screen.recorded({ id: commandId,
        conversationId: this.screen.selected() });
      if (attempt !== this.attempt) return;
      if (!recorded) {
        this.screen.error.set('');
        this.markNotConfirmed(turnId);
        return;
      }
      await this.screen.catchUp(this.screen.selected(), this.screen.revision());
    } catch (error) {
      if (attempt === this.attempt) this.screen.fail(error);
    }
  }

  notConfirmedFor(turnId: string): boolean {
    return Boolean(turnId && this.notConfirmedTurnId() === turnId);
  }

  apply(row: ChatRow): void {
    if (row.type !== 'agent.turn_completed' && row.type !== 'agent.turn_failed'
      && row.type !== 'agent.output_lost') return;
    const turnId = row.data['turnId'];
    if (typeof turnId !== 'string') return;
    if (this.stoppingTurnId() !== turnId && this.notConfirmedTurnId() !== turnId) return;
    this.reset();
  }

  reset(): void {
    this.attempt += 1;
    this.clearTimer();
    this.stoppingTurnId.set('');
    this.notConfirmedTurnId.set('');
  }

  private startTimer(turnId: string, attempt: number): void {
    this.timer = setTimeout(() => {
      if (attempt !== this.attempt || this.stoppingTurnId() !== turnId) return;
      this.markNotConfirmed(turnId);
    }, 10_000);
  }

  private markNotConfirmed(turnId: string): void {
    this.clearTimer();
    this.stoppingTurnId.set('');
    this.notConfirmedTurnId.set(turnId);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
