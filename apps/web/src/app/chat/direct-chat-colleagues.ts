import { signal } from '@angular/core';
import type { Colleague } from './recipient-picker';
import { searchColleagues } from './direct-chat-api';
import { mergeDirectColleagues } from './direct-chat-display';

type ReadState = 'idle' | 'loading' | 'ready' | 'failed';

export class DirectChatColleagues {
  readonly state = signal<ReadState>('loading');
  readonly known = signal<Colleague[]>([]);
  readonly rows = signal<Colleague[]>([]);
  private request: AbortController | undefined;
  private readonly readAllowed: () => boolean;
  private readonly accessChanged: () => void;

  constructor(
    readAllowed: () => boolean,
    accessChanged: () => void,
  ) {
    this.readAllowed = readAllowed;
    this.accessChanged = accessChanged;
  }

  async load(query: string): Promise<void> {
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.state.set('loading');
    this.rows.set([]);
    const result = await searchColleagues(query, request.signal);
    if (request.signal.aborted || this.request !== request || !this.readAllowed()) return;
    if (result.kind === 'ok') {
      this.rows.set(result.value.rows);
      this.known.set(mergeDirectColleagues(this.known(), result.value.rows));
      this.state.set('ready');
      return;
    }
    this.state.set('failed');
    if (result.kind === 'access_changed') this.accessChanged();
  }

  clear(): void {
    this.request?.abort();
    this.request = undefined;
    this.rows.set([]);
    this.known.set([]);
    this.state.set('idle');
  }
}
