import { signal } from '@angular/core';
import { chatListWithWelcomeSchema, type WelcomeListRow } from '@opencrane/protocol';
import { z } from 'zod';

type ArchiveState = 'loading' | 'ready' | 'saving' | 'unknown' | 'changed' | 'unavailable';
type ArchiveCommand = {
  commandId: string;
  welcomeId: string;
  archived: boolean;
  expectedArchivePosition: number;
};
const archiveReceiptSchema = z.object({
  status: z.literal('confirmed'), commandId: z.string(),
  operation: z.literal('onboarding.welcome_archive_set'),
  position: z.number().int().positive(),
});

export class WelcomeArchive {
  readonly row = signal<WelcomeListRow | null>(null);
  readonly state = signal<ArchiveState>('loading');
  private pending: ArchiveCommand | null = null;
  private welcomeId = '';
  private revision = 0;
  private readonly onDenied: (status: number) => void;
  private readonly fetcher: typeof fetch;

  constructor(onDenied: (status: number) => void,
    fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.onDenied = onDenied;
    this.fetcher = fetcher;
  }

  clear(): void {
    this.revision += 1;
    this.pending = null;
    this.welcomeId = '';
    this.row.set(null);
    this.state.set('loading');
  }

  async load(welcomeId: string, signal: AbortSignal, minimumPosition = 0): Promise<void> {
    const revision = ++this.revision;
    this.welcomeId = welcomeId;
    this.state.set('loading');
    try {
      const row = await this.findRow(welcomeId, signal);
      if (!this.current(revision, signal)) return;
      if (!row || row.archivePosition < minimumPosition) {
        this.state.set('unavailable');
        return;
      }
      this.row.set(row);
      this.state.set('ready');
    } catch (error) {
      if (!this.current(revision, signal)) return;
      if (error instanceof Error && error.message === 'access_changed') return;
      this.state.set('unavailable');
    }
  }

  async change(signal: AbortSignal): Promise<void> {
    const row = this.row();
    if (this.state() !== 'ready' || !row || this.pending) return;
    this.pending = { commandId: crypto.randomUUID(), welcomeId: row.welcomeId,
      archived: !row.archived, expectedArchivePosition: row.archivePosition };
    this.state.set('saving');
    await this.send(signal);
  }

  async check(signal: AbortSignal): Promise<void> {
    const pending = this.pending;
    if (!pending || this.state() !== 'unknown') return;
    this.state.set('saving');
    try {
      const response = await this.fetcher(
        `/api/personal/changes/${encodeURIComponent(pending.commandId)}`,
        { cache: 'no-store', signal });
      if (this.checkDenied(response.status) || signal.aborted) return;
      if (!response.ok) {
        this.state.set('unknown');
        return;
      }
      await this.confirm(response, pending, signal);
    } catch {
      if (!signal.aborted) this.state.set('unknown');
    }
  }

  private async send(signal: AbortSignal): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    try {
      const response = await this.fetcher('/api/onboarding/welcome/archive', {
        method: 'POST', cache: 'no-store', signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(pending),
      });
      if (this.checkDenied(response.status) || signal.aborted) return;
      if (response.status === 409) {
        this.pending = null;
        this.state.set('changed');
        return;
      }
      if (!response.ok) {
        this.state.set('unknown');
        return;
      }
      await this.confirm(response, pending, signal);
    } catch {
      if (!signal.aborted) this.state.set('unknown');
    }
  }

  private async confirm(response: Response, pending: ArchiveCommand,
    signal: AbortSignal): Promise<void> {
    const parsed = archiveReceiptSchema.safeParse(await response.json());
    if (signal.aborted || this.pending !== pending) return;
    if (!parsed.success || parsed.data.commandId !== pending.commandId) {
      this.state.set('unknown');
      return;
    }
    this.pending = null;
    await this.load(pending.welcomeId, signal, parsed.data.position);
  }

  private async findRow(welcomeId: string, signal: AbortSignal): Promise<WelcomeListRow | null> {
    for (const section of ['recent', 'archived']) {
      let cursor: string | null = null;
      do {
        const url = new URL('/api/conversations', location.origin);
        url.searchParams.set('section', section);
        url.searchParams.set('q', 'welcome');
        url.searchParams.set('limit', '50');
        if (cursor) url.searchParams.set('cursor', cursor);
        const response = await this.fetcher(url.pathname + url.search,
          { cache: 'no-store', signal });
        if (this.checkDenied(response.status)) throw new Error('access_changed');
        if (!response.ok) throw new Error('list_unavailable');
        const page = chatListWithWelcomeSchema.parse(await response.json());
        for (const row of page.rows) {
          if (row.kind === 'welcome' && row.welcomeId === welcomeId) return row;
        }
        cursor = page.nextCursor ?? null;
      } while (cursor);
    }
    return null;
  }

  private checkDenied(status: number): boolean {
    if (status !== 401 && status !== 403) return false;
    this.clear();
    this.onDenied(status);
    return true;
  }

  private current(revision: number, signal: AbortSignal): boolean {
    return !signal.aborted && revision === this.revision;
  }
}
