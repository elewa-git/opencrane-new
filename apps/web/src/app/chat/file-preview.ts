// File-view interaction adapted from Open Terminal b58442aa8599755525878f917b621e0145b0e8f7 (MIT).
// Original/preview fallback and workspace root: see docs/design/chat/OPEN-TERMINAL-LICENSE.txt.
import { ModalSheet } from '../ui/modal-sheet';
import { SharedState, type PresentationState } from '../shared-state/shared-state';
import {
  ChangeDetectionStrategy, Component, afterNextRender, computed, inject, input, output, signal,
  type OnDestroy,
} from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';

@Component({
  selector: 'oc-file-preview',
  imports: [SharedState, ModalSheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<oc-modal-sheet [open]="true" [title]="filename()"
    description="File preview" backLabel="Close preview"
    (closed)="closed.emit()">
    <div role="status" aria-live="polite">
      <oc-shared-state [kind]="statusKind()" [message]="status()"
        [evidenceAt]="evidenceAt()" [showAction]="false" />
    </div>
    <section aria-label="Preview content" [attr.aria-busy]="statusKind() === 'checking'">
    @if (kind() === 'image') { <img [src]="url()" [alt]="path()"> }
    @if (kind() === 'pdf') {
      <iframe [src]="safeUrl()" title="Document preview" referrerpolicy="no-referrer"></iframe>
    }
    @if (text()) { <pre>{{ text() }}</pre> }
    </section>
    @if (url()) {
      <a overlayFooter [href]="originalUrl()" [download]="filename()">↓ Download original file</a>
    }
  </oc-modal-sheet>`,
  styles: `
    a { display: inline-flex; align-items: center; justify-content: center; min-height: 44px;
      padding: 8px 16px; background: var(--oc-accent); color: var(--oc-ink-strong);
      border-radius: var(--oc-radius-button); text-decoration: none; }
    iframe { width: 100%; height: 60dvh; border: 0; }
    img { max-width: 100%; max-height: 60dvh; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    @media (max-width: 600px) { a { display: flex; } }
  `,
})
export class FilePreview implements OnDestroy {
  readonly path = input.required<string>();
  readonly conversationId = input.required<string>();
  readonly closed = output<void>();
  protected readonly originalUrl = computed(() => `/api/conversations/${encodeURIComponent(this.conversationId())}/files/view?path=${encodeURIComponent(this.path())}`);
  protected readonly status = signal('Loading preview…');
  protected readonly statusKind = signal<PresentationState>('checking');
  protected readonly evidenceAt = signal<string | undefined>(undefined);
  protected readonly kind = signal('');
  protected readonly text = signal('');
  protected readonly url = signal('');
  protected readonly safeUrl = signal<SafeResourceUrl | undefined>(undefined);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly abort = new AbortController();
  protected readonly filename = computed(this.fileName.bind(this));
  constructor() {
    afterNextRender(this.startLoading.bind(this));
  }
  private startLoading(): void {
    void this.load();
  }
  private fileName(): string {
    const parts = this.path().split('/');
    return parts.at(-1) ?? this.path();
  }
  ngOnDestroy(): void { this.abort.abort(); if (this.url()) URL.revokeObjectURL(this.url()); }
  private async load(): Promise<void> {
    try {
      const endpoint = this.originalUrl();
      const response = await fetch(`${endpoint}&preview=true`, { signal: this.abort.signal });
      if (!response.ok) throw new Error('File unavailable');
      const chunks = await previewBytes(response);
      const type = response.headers.get('content-type')?.split(';')[0] ?? '';
      const blob = new Blob(chunks, { type });
      this.url.set(URL.createObjectURL(blob));
      this.evidenceAt.set(new Date().toISOString());
      if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) this.kind.set('image');
      else if (type === 'application/pdf') { this.kind.set('pdf'); this.safeUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(`${this.url()}#toolbar=0&navpanes=0&view=FitH`)); }
      else if (type.startsWith('text/') && type !== 'text/html') this.text.set(await blob.text());
      if (this.kind() || this.text()) {
        this.statusKind.set('ready');
        this.status.set('Preview ready');
      } else {
        this.statusKind.set('ready');
        this.status.set('No rendered preview — download the original file.');
      }
    } catch {
      if (!this.abort.signal.aborted) {
        this.statusKind.set('failed');
        this.status.set('Preview unavailable. File access is not available for this session yet.');
      }
    }
  }
}

async function previewBytes(response: Response): Promise<Uint8Array<ArrayBuffer>[]> {
      const reader = response.body?.getReader(); if (!reader) throw new Error('No file body');
      const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 20 * 1024 * 1024) { await reader.cancel(); throw new Error('Preview too large'); }
        chunks.push(new Uint8Array(part.value));
      }
  return chunks;
}
