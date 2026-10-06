import {
  ChangeDetectionStrategy, Component, ElementRef, afterEveryRender, signal, viewChild,
  type OnDestroy, type OnInit,
} from '@angular/core';
import { chatColleaguesSchema } from '@opencrane/protocol';

type Colleague = { memberId: string; displayName: string | null };

@Component({
  selector: 'oc-direct-chat',
  templateUrl: './direct-chat.html',
  styleUrl: './direct-chat.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DirectChat implements OnInit, OnDestroy {
  protected readonly query = signal('');
  protected readonly colleagues = signal<Colleague[]>([]);
  protected readonly selected = signal<Colleague | undefined>(undefined);
  protected readonly status = signal('Loading colleagues…');
  private readonly lifetime = new AbortController();
  private readonly search = viewChild<ElementRef<HTMLInputElement>>('searchField');
  private readonly changeButton = viewChild<ElementRef<HTMLButtonElement>>('changeButton');
  protected readonly searchState = signal<'loading' | 'ready' | 'failed'>('loading');
  private searchRequest: AbortController | undefined;
  private focusChangeButton = false;
  private focusSearch = false;

  constructor() {
    afterEveryRender(this.restoreFocus.bind(this));
  }

  ngOnInit(): void {
    void this.searchColleagues('');
  }

  ngOnDestroy(): void {
    this.lifetime.abort();
    this.searchRequest?.abort();
  }

  protected queryChanged(event: Event): void {
    const field = event.target;
    if (!(field instanceof HTMLInputElement)) return;
    const query = field.value;
    this.query.set(query);
    void this.searchColleagues(query);
  }

  protected selectColleague(colleague: Colleague): void {
    this.selected.set(colleague);
    this.status.set('Recipient selected. Your message has not been sent.');
    this.focusChangeButton = true;
  }

  protected changeRecipient(): void {
    this.selected.set(undefined);
    this.focusSearch = true;
    this.status.set('Choose one colleague for this direct conversation.');
  }

  protected displayName(colleague: Colleague): string {
    return colleague.displayName?.trim() || colleague.memberId;
  }

  private async searchColleagues(query: string): Promise<void> {
    this.searchRequest?.abort();
    const request = new AbortController();
    this.searchRequest = request;
    this.searchState.set('loading');
    this.colleagues.set([]);
    this.status.set('Loading colleagues…');
    const parameters = new URLSearchParams({ q: query, limit: '20' });
    const options = { headers: { accept: 'application/json' }, signal: request.signal };
    try {
      const response = await fetch(`/api/chat/colleagues?${parameters}`, options);
      if (!this.isCurrentSearch(request)) return;
      if (!response.ok) {
        this.searchFailed();
        return;
      }
      const raw: unknown = await response.json();
      if (!this.isCurrentSearch(request)) return;
      const parsed = chatColleaguesSchema.safeParse(raw);
      if (!parsed.success) {
        this.searchFailed();
        return;
      }
      this.colleagues.set(parsed.data.rows);
      this.searchState.set('ready');
      this.status.set('Colleagues loaded.');
    } catch {
      if (this.isCurrentSearch(request)) this.searchFailed();
    }
  }

  private isCurrentSearch(request: AbortController): boolean {
    // Ignore replies from requests that were replaced, even if fetch did not stop them.
    return this.searchRequest === request && !request.signal.aborted
      && !this.lifetime.signal.aborted;
  }

  private searchFailed(): void {
    this.searchState.set('failed');
    this.status.set('Could not search colleagues. Try again.');
  }

  private restoreFocus(): void {
    if (this.focusChangeButton) {
      this.focusChangeButton = false;
      requestAnimationFrame(this.focusSelected.bind(this));
      return;
    }
    if (this.focusSearch) {
      this.focusSearch = false;
      requestAnimationFrame(this.focusSearchField.bind(this));
    }
  }

  private focusSelected(): void {
    this.changeButton()?.nativeElement.focus();
  }

  private focusSearchField(): void {
    this.search()?.nativeElement.focus();
  }
}
