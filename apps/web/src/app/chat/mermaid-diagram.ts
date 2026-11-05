import {
  ChangeDetectionStrategy, Component, effect, inject, InjectionToken, input, signal,
  type OnDestroy,
} from '@angular/core';
import { untilAborted } from './until-aborted';

type RenderMermaid = (code: string, signal?: AbortSignal) => Promise<{ svg: string }>;

async function loadAndRender(code: string, signal?: AbortSignal): Promise<{ svg: string }> {
  const loading = import('./mermaid-renderer');
  const { renderMermaid } = await untilAborted(loading, signal);
  signal?.throwIfAborted();
  return renderMermaid(code, signal);
}

function rendererFactory(): RenderMermaid {
  return loadAndRender;
}

const rendererOptions = { providedIn: 'root' as const, factory: rendererFactory };
export const MERMAID_RENDERER = new InjectionToken<RenderMermaid>('Mermaid renderer', rendererOptions);

function byteToCharacter(byte: number): string {
  return String.fromCharCode(byte);
}

async function renderDiagram(
  code: string, render: RenderMermaid, signal: AbortSignal, volatile: boolean,
): Promise<string> {
  let renderSignal: AbortSignal | undefined;
  if (volatile) {
    renderSignal = signal;
  }
  const drawing = render(code, renderSignal);
  const result = await untilAborted(drawing, signal);
  signal.throwIfAborted();
  // Join the warning's text spans without inserting untrusted SVG into the parent document.
  const text = result.svg.replace(/<\/?tspan\b[^>]*>/g, '');
  const joinedText = text.replace(/\s/g, '');
  if (joinedText.includes('Maximumtextsizeindiagramexceeded')) {
    throw new Error('Diagram exceeds the text limit');
  }
  const bytes = new TextEncoder().encode(result.svg);
  const characters = Array.from(bytes, byteToCharacter);
  const binary = characters.join('');
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

@Component({
  selector: 'oc-mermaid-diagram',
  template: `
    @if (imageUrl()) {
      <figure><img [src]="imageUrl()" alt="Diagram" /></figure>
    } @else {
      <section class="code-block" aria-label="Diagram source">
        <div class="code-heading"><span>Mermaid</span>
          <button type="button" (click)="copySource()">Copy code</button>
        </div>
        <pre><code>{{ code() }}</code></pre>
        @if (copyStatus()) {
          <span role="status">{{ copyStatus() }}</span>
        }
      </section>
    }
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    figure, .code-block { margin: 0 0 12px; }
    figure { max-width: 100%; overflow-x: auto; }
    img { display: block; max-width: 100%; height: auto; }
    .code-block { border: 1px solid #dee3e4; border-radius: 9px; overflow: hidden; }
    .code-heading { display: flex; align-items: center; justify-content: space-between;
      background: #eef1f2; padding: 0 12px; font: 11px var(--oc-font-mono); }
    .code-heading button { min-height: 44px; padding: 8px; flex-shrink: 0;
      color: var(--oc-accent-dark); }
    pre { overflow-x: auto; margin: 0; padding: 12px; background: #fbfcfc; }
    code { font: 12px var(--oc-font-mono); }
    [role=status] { display: block; padding: 4px 12px; font-size: 12px; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MermaidDiagram implements OnDestroy {
  private readonly lifetime = new AbortController();
  readonly code = input.required<string>();
  readonly closed = input.required<boolean>();
  readonly volatile = input(false);
  protected readonly imageUrl = signal<string | null>(null);
  protected readonly copyStatus = signal('');
  private readonly render = inject(MERMAID_RENDERER);
  private renderVersion = 0;

  constructor() {
    effect(this.renderCurrentCode.bind(this));
  }

  ngOnDestroy(): void {
    this.lifetime.abort();
    this.copyStatus.set('');
  }

  private renderCurrentCode(onCleanup: (cleanup: () => void) => void): void {
    const code = this.code();
    const closed = this.closed();
    this.imageUrl.set(null);
    this.copyStatus.set('');
    this.renderVersion += 1;
    const version = this.renderVersion;
    const controller = new AbortController();
    const volatile = this.volatile();
    const cancel = this.cancelRender.bind(this, controller);
    onCleanup(cancel);
    if (!closed || code.length > 50_000) {
      return;
    }
    void this.showDiagram(code, version, controller.signal, volatile);
  }

  private cancelRender(controller: AbortController): void {
    this.renderVersion += 1;
    controller.abort();
    this.imageUrl.set(null);
    this.copyStatus.set('');
  }

  private async showDiagram(
    code: string, version: number, signal: AbortSignal, volatile: boolean,
  ): Promise<void> {
    try {
      const imageUrl = await renderDiagram(code, this.render, signal, volatile);
      if (version === this.renderVersion) {
        this.imageUrl.set(imageUrl);
      }
    } catch {
      // Keep the source visible when Mermaid cannot parse or draw the reply.
      if (version === this.renderVersion) {
        this.imageUrl.set(null);
      }
    }
  }

  protected async copySource(): Promise<void> {
    try {
      const copying = navigator.clipboard.writeText(this.code());
      await untilAborted(copying, this.lifetime.signal);
      if (this.lifetime.signal.aborted) {
        return;
      }
      this.copyStatus.set('Copied');
    } catch {
      if (this.lifetime.signal.aborted) {
        return;
      }
      this.copyStatus.set('Could not copy. Try again.');
    }
  }
}
