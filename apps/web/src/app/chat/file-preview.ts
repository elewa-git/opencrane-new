// File-view interaction adapted from Open Terminal b58442aa8599755525878f917b621e0145b0e8f7 (MIT).
// Original/preview fallback and workspace root: see docs/design/chat/OPEN-TERMINAL-LICENSE.txt.
import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, inject, input, output, signal, viewChild, type OnDestroy } from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';

@Component({ selector: 'oc-file-preview', changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<dialog #dialog aria-label="File preview" (close)="closed.emit()"><header><div><small>▰ workspace</small><h2>{{ path() }}</h2></div><button type="button" aria-label="Close file preview" (click)="dialog.close()">×</button></header>
    <p role="status" aria-live="polite">{{ status() }}</p>
    @if (kind() === 'image') { <img [src]="url()" [alt]="path()"> }
    @if (kind() === 'pdf') { <iframe [src]="safeUrl()" sandbox title="Document preview"></iframe> }
    @if (text()) { <pre>{{ text() }}</pre> }
    @if (url()) { <a [href]="originalUrl()" [download]="path().split('/').at(-1)">↓ Download original file</a> }
  </dialog>`,
  styles: `dialog{width:min(900px,94vw);max-height:90dvh;border:1px solid #d9dfe0;border-radius:12px;padding:20px;color:#2b3133;animation:oc-hinge .42s var(--oc-ease-fold)}dialog::backdrop{background:#16191a55}header{display:flex;justify-content:space-between;gap:12px}h2{font-size:16px;overflow-wrap:anywhere}small,p{color:#616a6c;font-size:12px}button,a{min-height:44px;min-width:44px;display:inline-flex;align-items:center;justify-content:center}iframe{width:100%;height:60dvh;border:0}img{max-width:100%;max-height:60dvh}pre{white-space:pre-wrap;overflow-wrap:anywhere}`,
})
export class FilePreview implements OnDestroy {
  readonly path = input.required<string>();
  readonly conversationId = input.required<string>();
  readonly closed = output<void>();
  protected readonly originalUrl = computed(() => `/api/conversations/${encodeURIComponent(this.conversationId())}/files/view?path=${encodeURIComponent(this.path())}`);
  protected readonly status = signal('▱ Loading preview…');
  protected readonly kind = signal('');
  protected readonly text = signal('');
  protected readonly url = signal('');
  protected readonly safeUrl = signal<SafeResourceUrl | undefined>(undefined);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly abort = new AbortController();
  constructor() { afterNextRender(() => { this.dialog().nativeElement.showModal(); void this.load(); }); }
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
      if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) this.kind.set('image');
      else if (type === 'application/pdf') { this.kind.set('pdf'); this.safeUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(this.url())); }
      else if (type.startsWith('text/') && type !== 'text/html') this.text.set(await blob.text());
      this.status.set(this.kind() || this.text() ? '✓ Preview ready' : '▤ No rendered preview — download the original file.');
    } catch { if (!this.abort.signal.aborted) this.status.set('⊘ Preview unavailable. File access is not available for this session yet.'); }
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
