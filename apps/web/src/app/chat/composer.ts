// Follows OpenCrane 1's conversation-composer.component.ts; commit 10abd0ef6 (AGPL-3.0-or-later).
// The parent owns the draft and outputs. Native controls handle Enter and Stop instead of PrimeNG.
import { ChatIcon } from './icon';
import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import type { UploadChip } from './upload-batch';

@Component({ selector: 'oc-chat-composer', imports: [ChatIcon], templateUrl: './composer.html', styleUrl: './composer.css', changeDetection: ChangeDetectionStrategy.OnPush })
export class ChatComposer {
  readonly draft = input('');
  readonly placeholder = input('Message your agent…');
  readonly working = input(false);
  readonly stopping = input(false);
  readonly busy = input(false);
  readonly reason = input('');
  readonly queued = input(false);
  readonly teamSession = input(false);
  readonly directMode = input(false);
  readonly fileDrag = input(false);
  readonly memoryFree = input(false);
  readonly attachments = input<UploadChip[]>([]);
  readonly waitingForFiles = input('');
  readonly uploadsInProgress = input(false);
  readonly draftChange = output<string>();
  readonly submitted = output<string>();
  readonly stopped = output<void>();
  readonly attached = output<File[]>();
  readonly attachmentRemoved = output<string>();
  readonly attachmentRetried = output<string>();
  readonly memoryFreeSelected = output<void>();
  readonly privateSelected = output<void>();
  protected readonly attachOpen = signal(false);
  protected readonly notice = signal('');
  protected closeAttach(): void { this.attachOpen.set(false); document.getElementById('attach-toggle')?.focus(); }
  protected choose(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const files = Array.from(input.files ?? []);
    if (files.length) this.attached.emit(files);
    input.value = ''; this.closeAttach();
  }
  protected change(event: Event): void {
    if (event.target instanceof HTMLTextAreaElement) this.draftChange.emit(event.target.value);
  }
  protected keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      if (this.attachOpen()) this.closeAttach();
      else if (this.working()) this.stopped.emit();
    }
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault(); this.submit();
  }
  protected submit(): void {
    if (!this.working() && !this.busy() && !this.reason() && !this.waitingForFiles()
      && (this.draft().trim() || this.hasReadyFile())) this.submitted.emit(this.draft());
  }
  protected hasReadyFile(): boolean {
    return this.attachments().some(isReadyChip);
  }
}

function isReadyChip(chip: UploadChip): boolean {
  return chip.state === 'ready';
}
