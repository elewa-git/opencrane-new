import { ChangeDetectionStrategy, Component, effect, input, signal } from '@angular/core';

let nextDiagramId = 0;
let mermaidInitialised = false;

function byteToCharacter(byte: number): string {
  return String.fromCharCode(byte);
}

async function renderDiagram(code: string): Promise<string> {
  // Load Mermaid only after a reply contains a diagram.
  const { default: mermaid } = await import('mermaid');
  if (!mermaidInitialised) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      logLevel: 'fatal',
      suppressErrorRendering: true,
      // Keep reply directives from changing security settings or logging reply text.
      secure: ['secure', 'securityLevel', 'startOnLoad', 'logLevel', 'maxTextSize',
        'suppressErrorRendering', 'maxEdges', 'htmlLabels'],
    });
    mermaidInitialised = true;
  }
  nextDiagramId += 1;
  const result = await mermaid.render(`reply-diagram-${nextDiagramId}`, code);
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
export class MermaidDiagram {
  readonly code = input.required<string>();
  protected readonly imageUrl = signal<string | null>(null);
  protected readonly copyStatus = signal('');
  private renderVersion = 0;

  constructor() {
    effect(this.renderCurrentCode.bind(this));
  }

  private renderCurrentCode(): void {
    const code = this.code();
    this.imageUrl.set(null);
    this.copyStatus.set('');
    this.renderVersion += 1;
    const version = this.renderVersion;
    void this.showDiagram(code, version);
  }

  private async showDiagram(code: string, version: number): Promise<void> {
    try {
      const imageUrl = await renderDiagram(code);
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
      await navigator.clipboard.writeText(this.code());
      this.copyStatus.set('Copied');
    } catch {
      this.copyStatus.set('Could not copy. Try again.');
    }
  }
}
