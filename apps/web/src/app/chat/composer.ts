// Adapted from OpenCrane 1, 10abd0ef6, conversation-composer.component.ts (AGPL-3.0-or-later).
// Retains parent-owned draft and outputs; native controls and the handoff's Enter/Stop behaviour replace PrimeNG.
import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';

@Component({ selector: 'oc-chat-composer', templateUrl: './composer.html', styleUrl: './composer.css', changeDetection: ChangeDetectionStrategy.OnPush })
export class ChatComposer {
  readonly draft = input('');
  readonly working = input(false);
  readonly busy = input(false);
  readonly reason = input('');
  readonly queued = input(false);
  readonly draftChange = output<string>();
  readonly submitted = output<string>();
  readonly stopped = output<void>();
  protected readonly attachOpen = signal(false);
  protected readonly notice = signal('');
  protected closeAttach(): void { this.attachOpen.set(false); document.getElementById('attach-toggle')?.focus(); }
  protected change(event: Event): void {
    if (event.target instanceof HTMLTextAreaElement) this.draftChange.emit(event.target.value);
  }
  protected keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') this.attachOpen.set(false);
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault(); this.submit();
  }
  protected submit(): void {
    if (!this.working() && !this.busy() && !this.reason() && this.draft().trim()) this.submitted.emit(this.draft());
  }
}
