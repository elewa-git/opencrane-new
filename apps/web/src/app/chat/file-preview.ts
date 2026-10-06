// File-view interaction follows Open Terminal; commit b58442aa8599755525878f917b621e0145b0e8f7 (MIT).
// See docs/design/chat/OPEN-TERMINAL-LICENSE.txt for its preview fallback and workspace root.
import { ModalSheet } from '../ui/modal-sheet';
import { SharedState, type PresentationState } from '../shared-state/shared-state';
import {
  ChangeDetectionStrategy, Component, afterNextRender, computed, inject, input, output,
  signal, type OnDestroy,
} from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import {
  capturedByLine, fileName, fileSize, fileUrl, imageSize, screenshotCaption,
  type ScreenshotFacts,
} from './file-presentation';

interface PreviewFailure {
  kind: PresentationState;
  message: string;
  action: 'access' | 'retry' | '';
}

@Component({
  selector: 'oc-file-preview',
  imports: [SharedState, ModalSheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<oc-modal-sheet [open]="true" [title]="filename()"
    [description]="description()" backLabel="Close preview" (closed)="closed.emit()">
    <div role="status" aria-live="polite">
      <oc-shared-state [kind]="statusKind()" [message]="status()"
        [evidenceAt]="evidenceAt()" [showAction]="false" />
    </div>
    @if (failure()) {
      @if (failure()!.action === 'access') {
        <button class="preview-action preview-access" type="button"
          (click)="checkAccessAndReload()">
          Check access and reopen
        </button>
      }
      @if (failure()!.action === 'retry') {
        <button class="preview-action" type="button" (click)="reload()">
          Try preview again
        </button>
      }
    }
    <section aria-label="Preview content" [attr.aria-busy]="statusKind() === 'checking'">
      @if (kind() === 'image') { <img [src]="url()" [alt]="imageAlt()"> }
      @if (kind() === 'pdf') {
        <iframe [src]="safeUrl()" title="Document preview" referrerpolicy="no-referrer"></iframe>
      }
      @if (text()) { <pre>{{ text() }}</pre> }
      @if (screenshot(); as facts) {
        <div class="screenshot-preview-row">PNG · {{ dimensions(facts) }} · {{ size(facts) }}</div>
        <dl class="screenshot-facts">
          <dt>Computer</dt><dd><span class="computer-id">{{ facts.computerId }}</span>
            · generation {{ facts.generation }}</dd>
          <dt>Saved to</dt><dd>Files · #{{ conversationTitle() }}</dd>
        </dl>
      }
    </section>
    @if (url() && downloadAllowed()) {
      <a overlayFooter [href]="originalUrl()" [download]="filename()">
        ↓ Download original file
      </a>
    }
  </oc-modal-sheet>`,
  styles: `
    a, .preview-action { display: inline-flex; align-items: center; justify-content: center;
      min-height: 44px; padding: 8px 16px; border: 1px solid var(--oc-border-input);
      background: var(--oc-accent); color: var(--oc-ink-strong);
      border-radius: var(--oc-radius-button); text-decoration: none; font: inherit; }
    .preview-action { margin: 8px 0; background: white; }
    .preview-access { background: var(--oc-accent); }
    iframe { width: 100%; height: 60dvh; border: 0; }
    img { display: block; max-width: 100%; max-height: 50dvh; object-fit: contain; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    .screenshot-preview-row { margin-top: 12px; font-size: 13px; }
    .screenshot-facts { display: grid; grid-template-columns: auto minmax(0, 1fr);
      gap: 8px 12px; margin: 16px 0; font-size: 13px; }
    .screenshot-facts dt { color: var(--oc-ink-muted); }
    .screenshot-facts dd { margin: 0; overflow-wrap: anywhere; }
    .computer-id { font-family: var(--oc-font-mono); }
    @media (max-width: 600px) {
      a { display: flex; width: 100%; }
      .preview-action { display: flex; width: 100%; }
      .screenshot-facts { grid-template-columns: minmax(0, 1fr); gap: 3px; }
      .screenshot-facts dd + dt { margin-top: 8px; }
    }
  `,
})
export class FilePreview implements OnDestroy {
  readonly path = input.required<string>();
  readonly conversationId = input.required<string>();
  readonly screenshot = input<ScreenshotFacts | undefined>();
  readonly createdBy = input<'you' | 'participant'>('you');
  readonly conversationTitle = input('');
  readonly downloadAllowed = input(true);
  readonly closed = output<void>();
  readonly accessCheckRequested = output<void>();
  protected readonly originalUrl = computed(this.originalFileUrl.bind(this));
  protected readonly filename = computed(this.displayFileName.bind(this));
  protected readonly status = signal('Loading preview…');
  protected readonly statusKind = signal<PresentationState>('checking');
  protected readonly evidenceAt = signal<string | undefined>(undefined);
  protected readonly kind = signal('');
  protected readonly text = signal('');
  protected readonly url = signal('');
  protected readonly safeUrl = signal<SafeResourceUrl | undefined>(undefined);
  protected readonly failure = signal<PreviewFailure | undefined>(undefined);
  protected readonly screenshotDescription = computed(this.screenshotLine.bind(this));
  protected readonly description = computed(this.sheetDescription.bind(this));
  protected readonly imageAlt = computed(this.previewImageAlt.bind(this));
  private readonly sanitizer = inject(DomSanitizer);
  private abort = new AbortController();

  constructor() {
    afterNextRender(this.startLoading.bind(this));
  }

  ngOnDestroy(): void {
    this.abort.abort();
    this.revokeUrl();
  }

  protected async reload(): Promise<void> {
    this.abort.abort();
    this.abort = new AbortController();
    this.revokeUrl();
    this.kind.set('');
    this.text.set('');
    this.safeUrl.set(undefined);
    this.failure.set(undefined);
    this.statusKind.set('checking');
    this.status.set('Loading preview…');
    await this.load();
  }

  protected async checkAccessAndReload(): Promise<void> {
    this.accessCheckRequested.emit();
    await this.reload();
  }

  protected dimensions(facts: ScreenshotFacts): string {
    return imageSize(facts.width, facts.height);
  }

  protected size(facts: ScreenshotFacts): string {
    return fileSize(facts.size);
  }

  private startLoading(): void { void this.load(); }

  private async load(): Promise<void> {
    try {
      const response = await fetch(`${this.originalUrl()}&preview=true`, {
        signal: this.abort.signal,
      });
      if (!response.ok) {
        this.setFailure(previewFailure(response.status));
        return;
      }
      await this.showResponse(response);
    } catch {
      if (!this.abort.signal.aborted) this.setFailure(previewFailure(0));
    }
  }

  private async showResponse(response: Response): Promise<void> {
    const chunks = await previewBytes(response);
    const type = response.headers.get('content-type')?.split(';')[0] ?? '';
    const blob = new Blob(chunks, { type });
    this.url.set(URL.createObjectURL(blob));
    this.evidenceAt.set(new Date().toISOString());
    if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) {
      this.kind.set('image');
    } else if (type === 'application/pdf') {
      this.setPdfPreview();
    } else if (type.startsWith('text/') && type !== 'text/html') {
      this.text.set(await blob.text());
    }
    this.statusKind.set('ready');
    if (this.kind() || this.text()) this.status.set('Preview ready');
    else this.status.set('No rendered preview — download the original file.');
  }

  private setPdfPreview(): void {
    this.kind.set('pdf');
    const previewUrl = `${this.url()}#toolbar=0&navpanes=0&view=FitH`;
    this.safeUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(previewUrl));
  }

  private setFailure(failure: PreviewFailure): void {
    this.failure.set(failure);
    this.statusKind.set(failure.kind);
    this.status.set(failure.message);
  }

  private revokeUrl(): void {
    const currentUrl = this.url();
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    this.url.set('');
  }

  private originalFileUrl(): string {
    return fileUrl(this.conversationId(), this.path());
  }

  private displayFileName(): string {
    return fileName(this.path());
  }

  private screenshotLine(): string {
    const facts = this.screenshot();
    if (!facts) return 'File preview';
    return capturedByLine(this.createdBy(), facts, false);
  }

  private sheetDescription(): string {
    return this.screenshot() ? this.screenshotDescription() : 'File preview';
  }

  private previewImageAlt(): string {
    const facts = this.screenshot();
    return facts ? screenshotCaption(facts.computerId) : this.path();
  }
}

function previewFailure(status: number): PreviewFailure {
  if (status === 401 || status === 403) {
    return { kind: 'access_changed',
      message: 'Preview unavailable. Your access is checked again before the image loads.',
      action: 'access' };
  }
  if (status === 404) {
    return { kind: 'refused', message: 'Preview unavailable. This file is not available to you.',
      action: '' };
  }
  return { kind: 'failed', message: "Preview unavailable. The preview couldn't load.",
    action: 'retry' };
}

async function previewBytes(response: Response): Promise<Uint8Array<ArrayBuffer>[]> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No file body');
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 20 * 1024 * 1024) {
      await reader.cancel();
      throw new Error('Preview too large');
    }
    chunks.push(new Uint8Array(part.value));
  }
  return chunks;
}
