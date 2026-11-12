import { ChangeDetectionStrategy, Component, effect, HostListener, input, signal,
  type OnDestroy } from '@angular/core';
import { personalConnectionNeedsSchema } from '@opencrane/protocol';
import type { z } from 'zod';

@Component({
  selector: 'oc-personal-connection-notice',
  template: `@for (server of needs(); track server.serverId) {
    <p role="status">{{ server.name }} needs your personal key.
      <a [href]="'/account/tools?serverId=' + server.serverId">Connect your key in My tools</a>.
      This server's tools are unavailable until you connect and choose a verified key.
    </p>
  }`,
  styles: `p { padding: .75rem; margin: .5rem 1rem; border: 1px solid var(--border, #ddd);
    border-radius: .5rem; overflow-wrap: anywhere; font-size: .875rem; }`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PersonalConnectionNotice implements OnDestroy {
  readonly assistantId = input.required<string>();
  protected readonly needs = signal<z.infer<typeof personalConnectionNeedsSchema>['rows']>([]);
  private request: AbortController | undefined;

  constructor() {
    effect(this.assistantChanged.bind(this));
  }

  private assistantChanged(): void {
    const assistantId = this.assistantId();
    this.needs.set([]);
    void this.load(assistantId);
  }

  @HostListener('window:focus')
  protected refresh(): void {
    void this.load(this.assistantId());
  }

  ngOnDestroy(): void {
    this.request?.abort();
    this.needs.set([]);
  }

  private async load(assistantId: string): Promise<void> {
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    try {
      const url = `/api/my/tools/needs?assistantId=${encodeURIComponent(assistantId)}`;
      const response = await fetch(url, { cache: 'no-store', signal: request.signal });
      if (request.signal.aborted) return;
      if (!response.ok) {
        this.needs.set([]);
        return;
      }
      const raw: unknown = await response.json();
      if (request.signal.aborted) return;
      this.needs.set(personalConnectionNeedsSchema.parse(raw).rows);
    } catch {
      // Keep a failed auxiliary read separate from the conversation and its access checks.
      if (!request.signal.aborted) this.needs.set([]);
    }
  }
}
