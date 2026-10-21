import { Overlay } from '../ui/overlay';
import { JsonPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, output, signal,
  type OnDestroy, type OnInit } from '@angular/core';
import { modelAccessGrantSchema, type ToolPolicy } from '@opencrane/protocol';
import { z } from 'zod';

const accessSchema = z.object({ serverId: z.string(), complete: z.boolean(),
  projection: z.object({ content: z.literal('current'), iam: z.literal('current') }),
  grants: z.array(modelAccessGrantSchema.extend({
    membershipStatus: z.enum(['joined', 'invited', 'departed', 'unknown']).nullable(),
    iam: z.literal('current'),
  })) });

@Component({
  selector: 'oc-initial-review-confirmation',
  imports: [JsonPipe, Overlay],
  templateUrl: './initial-review-confirmation.html',
  styleUrl: './initial-review-confirmation.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InitialReviewConfirmation implements OnInit, OnDestroy {
  readonly policy = input.required<ToolPolicy>();
  readonly name = input.required<string>();
  readonly enabled = input(false);
  readonly confirmed = output();
  readonly accessEnded = output<Response>();
  protected readonly audience = signal<z.infer<typeof accessSchema> | undefined>(undefined);
  protected readonly audienceMessage = signal('Loading saved audience…');
  protected readonly factsMessage = signal('Checking connection facts…');
  protected readonly confirming = signal(false);
  protected readonly acknowledged = signal(false);
  private readonly request = new AbortController();

  ngOnInit(): void {
    void this.read('access');
    void this.read('facts');
  }

  ngOnDestroy(): void {
    this.request.abort();
  }

  protected open(): void {
    this.acknowledged.set(false);
    this.confirming.set(true);
  }

  protected confirm(): void {
    if (!this.enabled() || !this.audience()?.complete || !this.acknowledged()) return;
    this.confirming.set(false);
    this.confirmed.emit();
  }

  private async read(kind: 'access' | 'facts'): Promise<void> {
    const serverId = this.policy().serverId ?? '';
    try {
      const response = await fetch(`/api/org/integrations/${encodeURIComponent(serverId)}/${kind}`,
        { signal: this.request.signal, headers: { accept: 'application/json' } });
      if (this.request.signal.aborted) return;
      if (response.status === 401 || response.status === 403) {
        this.request.abort();
        this.audience.set(undefined);
        this.accessEnded.emit(response);
        return;
      }
      if (!response.ok) throw new Error('Read unavailable');
      if (kind === 'facts') {
        this.factsMessage.set('Account mode and connection below come from the saved tool policy.');
        return;
      }
      const raw: unknown = await response.json();
      if (this.request.signal.aborted) return;
      const audience = accessSchema.parse(raw);
      if (audience.serverId !== serverId || !audience.complete) throw new Error('Incomplete list');
      this.audience.set(audience);
      this.audienceMessage.set('Saved audience. Publishing does not change these grants.');
    } catch {
      if (this.request.signal.aborted) return;
      if (kind === 'access') this.audienceMessage.set('Audience unavailable. Reload before publishing.');
      else this.factsMessage.set('Additional connection facts are unavailable.');
    }
  }
}
