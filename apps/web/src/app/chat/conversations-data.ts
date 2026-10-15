import { computed, signal } from '@angular/core';
import { chatListSchema, sessionSlug, type ChatConversation } from '@opencrane/protocol';

export function workspaceTitle(
  denied: boolean, selected: string,
  turns: { author: string; text: string }[], conversations: ChatConversation[],
): string {
  if (denied) return 'Unavailable';
  if (!selected) return 'New session';
  for (const turn of turns) {
    if (turn.author === 'you' && turn.text) return sessionSlug(turn.text);
  }
  for (const conversation of conversations) {
    if (conversation.conversationId === selected) {
      return sessionSlug(conversation.title ?? 'Personal session');
    }
  }
  return sessionSlug('Personal session');
}

export type ConversationSection = 'recent' | 'archived';
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function conversationUrl(
  section: ConversationSection, query: string, limit: number, cursor?: string,
): string {
  const params = new URLSearchParams({ section, q: query, limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  return `/api/conversations?${params.toString()}`;
}

async function readPage(url: string, fetcher: Fetcher, signal?: AbortSignal) {
  const init: RequestInit = signal ? { signal } : {};
  const response = await fetcher(url, init);
  // Clear protected conversations as soon as the server refuses access.
  if (response.status === 401 || response.status === 403) throw new Error('access_changed');
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 409 && hasStatus(body, 'list_changed')) {
      throw new Error('list_changed');
    }
    throw new Error('unavailable');
  }
  const body: unknown = await response.json();
  return chatListSchema.parse(body);
}

function hasStatus(value: unknown, status: string): boolean {
  return typeof value === 'object' && value !== null && 'status' in value
    && value.status === status;
}

export class ConversationList {
  readonly section = signal<ConversationSection>('recent');
  readonly query = signal('');
  readonly rows = signal<ChatConversation[]>([]);
  readonly cursor = signal<string | null | undefined>(undefined);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly denied = signal(false);
  readonly announcement = signal('');
  readonly empty = computed(() => !this.loading() && !this.error() && !this.denied()
    && this.cursor() === null && this.rows().length === 0);
  readonly noMatches = computed(() => this.empty() && Boolean(this.query()));
  private revision = 0;
  private request?: AbortController;
  private readonly fetcher: Fetcher;

  constructor(fetcher: Fetcher = fetch) {
    this.fetcher = fetcher;
  }

  async change(section: ConversationSection, query: string): Promise<void> {
    this.request?.abort();
    this.revision += 1;
    this.section.set(section);
    this.query.set(query.slice(0, 100));
    this.rows.set([]);
    this.cursor.set(undefined);
    this.error.set('');
    this.denied.set(false);
    await this.read(true, false);
  }

  async loadMore(): Promise<void> {
    if (this.loading() || this.denied() || this.cursor() === null) return;
    await this.read(false, false);
  }

  destroy(): void {
    this.revision += 1;
    this.request?.abort();
  }

  private async read(firstPage: boolean, changedOnce: boolean): Promise<void> {
    const revision = this.revision;
    const cursor = firstPage ? undefined : this.cursor();
    const url = conversationUrl(this.section(), this.query(), 20, cursor ?? undefined);
    const request = new AbortController();
    this.request = request;
    this.loading.set(true);
    this.error.set('');
    if (!changedOnce) {
      this.announcement.set(firstPage ? 'Loading conversations…' : 'Loading more conversations…');
    }
    try {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
      const page = await readPage(url, this.fetcher, signal);
      if (revision !== this.revision) return;
      this.applyPage(page, firstPage);
      if (!changedOnce) this.announcement.set('Conversations loaded.');
    } catch (error) {
      if (revision !== this.revision) return;
      await this.handleFailure(error, changedOnce);
    } finally {
      if (revision === this.revision) this.loading.set(false);
    }
  }

  private applyPage(page: ReturnType<typeof chatListSchema.parse>, firstPage: boolean): void {
    const existing = firstPage ? [] : this.rows();
    const seen = new Set(existing.map(conversationId));
    const rows = [...existing];
    for (const row of page.rows) {
      if (seen.has(row.conversationId)) continue;
      seen.add(row.conversationId);
      rows.push(row);
    }
    this.rows.set(rows);
    this.cursor.set(page.nextCursor ?? null);
  }

  private async handleFailure(error: unknown, changedOnce: boolean): Promise<void> {
    if (error instanceof Error && error.message === 'access_changed') {
      this.revision += 1;
      this.rows.set([]);
      this.cursor.set(undefined);
      this.denied.set(true);
      this.loading.set(false);
      this.announcement.set('Access to conversations changed.');
      return;
    }
    if (error instanceof Error && error.message === 'list_changed' && !changedOnce) {
      this.rows.set([]);
      this.cursor.set(undefined);
      this.announcement.set('Conversation list changed. Showing the latest results.');
      await this.read(true, true);
      return;
    }
    this.error.set('Conversations are unavailable right now. Try again.');
    this.announcement.set('Conversations are unavailable right now.');
  }
}

function conversationId(row: ChatConversation): string {
  return row.conversationId;
}

export async function findConversation(
  conversationId: string, fetcher: Fetcher = fetch, signal?: AbortSignal,
): Promise<ChatConversation | null> {
  let changedOnce = false;
  while (true) {
    try {
      return await searchConversationSections(conversationId, fetcher, signal);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'list_changed' || changedOnce) {
        throw error;
      }
      // Restart at Recent page one because all old cursors may now point at another list.
      changedOnce = true;
    }
  }
}

async function searchConversationSections(
  conversationId: string, fetcher: Fetcher, signal?: AbortSignal,
): Promise<ChatConversation | null> {
  const sections: ConversationSection[] = ['recent', 'archived'];
  for (const section of sections) {
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
      const url = conversationUrl(section, '', 50, cursor);
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000);
      const page = await readPage(url, fetcher, requestSignal);
      for (const row of page.rows) {
        if (row.conversationId === conversationId) return row;
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
  }
  return null;
}

export function isTeamConversation(row: ChatConversation | undefined): boolean {
  return row?.mode === 'agent_session' && row.assistantKind === 'team';
}

export function includeRequestedConversation(
  rows: ChatConversation[], requested: ChatConversation,
): ChatConversation[] {
  for (const row of rows) {
    if (row.conversationId === requested.conversationId) return rows;
  }
  return [...rows, requested];
}

export function isSelectedConversation(conversationId: string, row: ChatConversation): boolean {
  return row.conversationId === conversationId;
}

export function displayAgentSessions(rows: ChatConversation[]): ChatConversation[] {
  const sessions: ChatConversation[] = [];
  for (const row of rows) {
    if (row.mode !== 'agent_session') continue;
    const title = row.title ? sessionSlug(row.title) : 'New session';
    sessions.push({ ...row, title });
  }
  return sessions;
}

type AgentResume = { kind: 'found'; row: ChatConversation }
  | { kind: 'missing' } | { kind: 'denied' } | { kind: 'unavailable' }
  | { kind: 'changed' };

export async function resumeAgentSession(
  conversationId: string, known: ChatConversation[],
): Promise<AgentResume> {
  let row = known.find(candidate => candidate.conversationId === conversationId);
  if (!row) {
    try {
      row = await findConversation(conversationId) ?? undefined;
    } catch (error) {
      if (error instanceof Error && error.message === 'access_changed') {
        return { kind: 'denied' };
      }
      if (error instanceof Error && error.message === 'list_changed') {
        return { kind: 'changed' };
      }
      return { kind: 'unavailable' };
    }
  }
  if (row?.mode !== 'agent_session') return { kind: 'missing' };
  const displayed = displayAgentSessions([row]);
  return { kind: 'found', row: displayed[0]! };
}
