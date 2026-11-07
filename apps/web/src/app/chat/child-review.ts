import { signal } from '@angular/core';
import { z } from 'zod';
import type { ChatConversation, ChatRow } from '@opencrane/protocol';

const assistantSchema = z.object({
  assistantId: z.string(), name: z.string().optional(), kind: z.literal('team'),
  canStartSession: z.boolean(), status: z.string(),
});
const assistantsSchema = z.object({ rows: z.array(assistantSchema) });
const reviewSchema = z.object({
  requestId: z.string(), sourceMessageId: z.string(), assistantId: z.string(),
  participantIds: z.array(z.string()), payingGroupId: z.string(),
  allowanceBoundCents: z.number().int().nonnegative(), review: z.string(),
  expiresAt: z.number(),
});
const statusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unknown') }),
  z.object({ state: z.literal('queued'), requestId: z.string() }),
  z.object({ state: z.literal('failed'), requestId: z.string() }),
]);
type Review = z.infer<typeof reviewSchema>;
type Assistant = z.infer<typeof assistantSchema>;
type Pending = { memberId: string; conversationId: string;
  sourceMessageId: string; requestId: string };

const pendingKey = 'opencrane-child-request';

function savedPending(): Pending | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null');
    const parsed = z.object({ memberId: z.string(), conversationId: z.string(), sourceMessageId: z.string(),
      requestId: z.string() }).safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export class ChildReview {
  readonly assistants = signal<Assistant[]>([]);
  readonly selectedAssistant = signal('');
  readonly source = signal<ChatRow | undefined>(undefined);
  readonly review = signal<Review | undefined>(undefined);
  readonly audience = signal<string[]>([]);
  readonly notice = signal('');
  readonly busy = signal(false);
  readonly pending = signal<Pending | undefined>(savedPending());
  private request: AbortController | undefined;
  // Ignore replies from an older chat after the current view or access changes.
  private generation = 0;
  readonly opener = signal<HTMLButtonElement | undefined>(undefined);
  private memberName = 'You';
  private readonly accessChanged: () => void;

  constructor(accessChanged: () => void) {
    this.accessChanged = accessChanged;
  }

  setMember(memberId: string, name: string | null | undefined): void {
    this.memberName = name ?? 'You';
    const pending = this.pending();
    if (pending && pending.memberId !== memberId) {
      this.pending.set(undefined);
      sessionStorage.removeItem(pendingKey);
    }
  }

  assistantName(assistantId: string): string {
    const assistant = this.assistants().find(candidate => candidate.assistantId === assistantId);
    return assistant?.name ?? assistantId;
  }

  audienceNames(participantIds: string[], memberId: string,
    colleagues: { memberId: string; displayName: string | null }[]): string {
    const names: string[] = [];
    for (const participantId of participantIds) {
      if (participantId === memberId) {
        names.push(this.memberName);
        continue;
      }
      const person = colleagues.find(candidate => candidate.memberId === participantId);
      names.push(person?.displayName ?? participantId);
    }
    return names.join(', ');
  }

  async loadForConversation(conversation: ChatConversation): Promise<void> {
    if (conversation.mode === 'group') await this.loadAssistants(conversation.conversationId);
  }

  reset(): void {
    this.generation += 1;
    this.request?.abort();
    this.assistants.set([]);
    this.selectedAssistant.set('');
    this.source.set(undefined);
    this.review.set(undefined);
    this.audience.set([]);
    this.notice.set('');
    this.busy.set(false);
    this.opener.set(undefined);
  }

  clearAccess(): void {
    this.reset();
    this.memberName = 'You';
    this.pending.set(undefined);
    sessionStorage.removeItem(pendingKey);
  }

  async loadAssistants(conversationId: string): Promise<void> {
    const generation = ++this.generation;
    this.request?.abort();
    this.request = new AbortController();
    try {
      const response = await fetch('/api/assistants', {
        headers: { accept: 'application/json' }, signal: this.request.signal,
      });
      if (generation !== this.generation) return;
      if (response.status === 401 || response.status === 403) {
        this.accessChanged();
        return;
      }
      if (!response.ok) throw new Error('Assistant list unavailable');
      const parsed = assistantsSchema.parse(await response.json());
      if (generation !== this.generation) return;
      const eligible = parsed.rows.filter(isEligibleAssistant);
      this.assistants.set(eligible);
      this.selectedAssistant.set(eligible[0]?.assistantId ?? '');
      const pending = this.pending();
      if (pending?.conversationId === conversationId) await this.checkStatus(conversationId);
    } catch {
      if (generation === this.generation) this.assistants.set([]);
    }
  }

  canOpen(row: ChatRow, conversation: ChatConversation | undefined, memberId: string): boolean {
    if (conversation?.mode !== 'group' || row.type !== 'message.posted') return false;
    if (row.data['authorId'] !== memberId || this.assistants().length === 0) return false;
    return !this.pending();
  }

  async open(row: ChatRow, conversation: ChatConversation, action: EventTarget | null): Promise<void> {
    if (!(action instanceof HTMLButtonElement) || this.busy() ||
        conversation.mode !== 'group') return;
    this.opener.set(action);
    this.source.set(row);
    this.notice.set('');
    this.audience.set([...conversation.participantIds]);
    await this.requestReview(conversation);
  }

  close(): void {
    if (this.busy() && this.pending() && this.source()) return;
    this.generation += 1;
    this.request?.abort();
    this.source.set(undefined);
    this.review.set(undefined);
    if (!this.pending()) this.notice.set('');
    this.busy.set(false);
    this.opener.set(undefined);
  }

  async chooseAudience(conversation: ChatConversation, memberId: string, onlyMe: boolean):
    Promise<void> {
    if (conversation.mode !== 'group') return;
    this.audience.set(onlyMe ? [memberId] : [...conversation.participantIds]);
    this.review.set(undefined);
    await this.requestReview(conversation);
  }

  async requestReview(conversation: ChatConversation): Promise<void> {
    const source = this.source();
    const assistantId = this.selectedAssistant();
    if (!source || !assistantId || this.busy()) return;
    const generation = ++this.generation;
    this.request?.abort();
    this.request = new AbortController();
    this.busy.set(true);
    this.review.set(undefined);
    this.notice.set('Checking this request…');
    const body = { requestId: crypto.randomUUID(), sourceMessageId: source.id,
      assistantId, participantIds: this.audience() };
    try {
      const response = await fetch(childUrl(conversation.conversationId, 'child-review'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: this.request.signal,
      });
      if (generation !== this.generation) return;
      if (response.status === 401 || response.status === 403) {
        this.accessChanged();
        return;
      }
      if (!response.ok) throw new Error('Review unavailable');
      const review = reviewSchema.parse(await response.json());
      if (generation !== this.generation) return;
      this.checkReviewBinding(review, source.id, body.requestId, assistantId);
      this.review.set(review);
      this.notice.set('');
    } catch {
      if (generation === this.generation) this.notice.set('Review unavailable. Try again.');
    } finally {
      if (generation === this.generation) this.busy.set(false);
    }
  }

  private checkReviewBinding(review: Review, sourceMessageId: string,
    requestId: string, assistantId: string): void {
    if (review.sourceMessageId !== sourceMessageId || review.requestId !== requestId ||
        review.assistantId !== assistantId) throw new Error('Review mismatch');
  }

  async start(conversation: ChatConversation, memberId: string): Promise<void> {
    if (conversation.mode !== 'group') return;
    const conversationId = conversation.conversationId;
    const review = this.review();
    if (!review || this.busy() || this.pending()) return;
    if (review.expiresAt <= Date.now()) {
      this.review.set(undefined);
      this.resetChoices(conversation);
      this.notice.set('This review expired. Review the request again.');
      return;
    }
    const source = this.source();
    if (!source || source.id !== review.sourceMessageId) return;
    const pending = { memberId, conversationId,
      sourceMessageId: source.id, requestId: review.requestId };
    this.pending.set(pending);
    sessionStorage.setItem(pendingKey, JSON.stringify(pending));
    this.busy.set(true);
    this.notice.set('Starting the child thread…');
    const generation = ++this.generation;
    try {
      const response = await fetch(childUrl(conversationId, 'children'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: review.requestId, sourceMessageId: source.id,
          review: review.review }),
      });
      if (generation !== this.generation) return;
      const queued = await this.handleStartResponse(response, pending, conversation, generation);
      if (!queued || generation !== this.generation) return;
      this.source.set(undefined);
      this.review.set(undefined);
      this.notice.set('Child thread queued. Check status for updates.');
    } catch {
      if (generation === this.generation) {
        this.source.set(undefined);
        this.review.set(undefined);
        this.notice.set('Start not confirmed. Check the same request status.');
      }
    } finally {
      if (generation === this.generation) this.busy.set(false);
    }
  }

  private resetChoices(conversation: Extract<ChatConversation, { mode: 'group' }>): void {
    this.audience.set([...conversation.participantIds]);
    this.selectedAssistant.set(this.assistants()[0]?.assistantId ?? '');
  }

  private async handleStartResponse(response: Response, pending: Pending,
    conversation: Extract<ChatConversation, { mode: 'group' }>, generation: number):
    Promise<boolean> {
    if (response.status === 401 || response.status === 403) {
      this.accessChanged();
      return false;
    }
    if (response.status === 409) {
      const error: unknown = await response.json();
      if (generation !== this.generation) return false;
      const stale = z.object({ status: z.literal('review_stale') }).safeParse(error);
      if (stale.success) {
        this.pending.set(undefined);
        sessionStorage.removeItem(pendingKey);
        this.review.set(undefined);
        this.resetChoices(conversation);
        this.notice.set('Access changed. Review the request again.');
        return false;
      }
    }
    if (!response.ok) throw new Error('Start status unavailable');
    const result = statusSchema.parse(await response.json());
    if (generation !== this.generation) return false;
    if (result.state !== 'queued' || result.requestId !== pending.requestId) {
      throw new Error('Start status unavailable');
    }
    return true;
  }

  async checkStatus(conversationId: string): Promise<void> {
    const pending = this.pending();
    if (!pending || pending.conversationId !== conversationId || this.busy()) return;
    this.busy.set(true);
    const generation = this.generation;
    try {
      const response = await fetch(childUrl(conversationId,
        `children/${encodeURIComponent(pending.requestId)}`), {
        headers: { accept: 'application/json' },
      });
      if (generation !== this.generation) return;
      if (response.status === 401 || response.status === 403) {
        this.accessChanged();
        return;
      }
      if (!response.ok) throw new Error('Status unavailable');
      const status = statusSchema.parse(await response.json());
      if (generation !== this.generation) return;
      if (status.state === 'queued') this.notice.set('Child thread queued.');
      else if (status.state === 'failed') this.notice.set('The child thread could not start.');
      else this.notice.set('Start not confirmed. Check the same request status.');
    } catch {
      if (generation === this.generation) this.notice.set('Status unavailable. Try again.');
    } finally {
      if (generation === this.generation) this.busy.set(false);
    }
  }
}

function isEligibleAssistant(assistant: Assistant): boolean {
  return assistant.canStartSession && assistant.status !== 'retired';
}

function childUrl(conversationId: string, suffix: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/${suffix}`;
}
