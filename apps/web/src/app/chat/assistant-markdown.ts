import {
  ChangeDetectionStrategy, Component, computed, ElementRef, inject, input, output, signal,
  type OnDestroy,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { DogEar } from '../ui/paper';
import { MermaidDiagram } from './mermaid-diagram';
import { parseMarkdown, type MarkdownBlock } from './markdown-parser';
import { fileName } from './file-presentation';
import { untilAborted } from './until-aborted';

@Component({
  selector: 'oc-assistant-markdown',
  imports: [NgTemplateOutlet, DogEar, MermaidDiagram],
  templateUrl: './assistant-markdown.html',
  styleUrls: ['./transcript.css', './assistant-markdown.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(focusin)': 'rememberFocus()', '(focusout)': 'forgetFocus()' },
})
export class AssistantMarkdown implements OnDestroy {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly lifetime = new AbortController();
  private returnFocus: HTMLElement | null = null;
  readonly text = input.required<string>();
  readonly availableFiles = input<string[]>([]);
  readonly volatile = input(false);
  readonly citationOpened = output<string>();
  readonly fileOpened = output<string>();
  protected readonly blocks = computed(this.parseReply.bind(this));
  protected readonly copyStatus = signal<{
    blockIndex: number;
    code: string;
    text: string;
  } | null>(null);

  private parseReply(): MarkdownBlock[] {
    return parseMarkdown(this.text());
  }

  protected publishedFile(link: string | undefined): string {
    if (!link) return '';
    const prefix = link.startsWith('file://') ? 'file:///workspace/artifacts/'
      : '/workspace/artifacts/';
    if (!link.startsWith(prefix)) return '';
    let name: string;
    try {
      name = decodeURIComponent(link.slice(prefix.length));
    } catch {
      return '';
    }
    if (!name || name.includes('/') || name.includes('\\')) return '';
    function matchesName(file: string): boolean {
      return fileName(file) === name;
    }
    const matches = this.availableFiles().filter(matchesName);
    return matches.length === 1 ? matches[0] ?? '' : '';
  }

  protected openFile(path: string): void {
    this.fileOpened.emit(path);
  }

  protected fileLabel(label: string, path: string): string {
    if (label.includes('/workspace/artifacts/')) return fileName(path);
    return label;
  }

  ngOnDestroy(): void {
    this.lifetime.abort();
    this.copyStatus.set(null);
    this.returnFocus?.focus();
    this.returnFocus = null;
  }

  protected rememberFocus(): void {
    if (!this.volatile()) return;
    // Remember the parent before Angular detaches the focused control.
    const element = this.element.nativeElement;
    this.returnFocus = element.closest<HTMLElement>('.transcript');
  }

  protected forgetFocus(): void {
    // Let destruction restore focus before a removal-triggered blur clears the parent.
    queueMicrotask(this.checkFocus.bind(this));
  }

  private checkFocus(): void {
    if (!this.element.nativeElement.contains(document.activeElement)) {
      this.returnFocus = null;
    }
  }

  protected async copyCode(block: MarkdownBlock, blockIndex: number): Promise<void> {
    try {
      const copying = navigator.clipboard.writeText(block.text);
      await untilAborted(copying, this.lifetime.signal);
      if (this.lifetime.signal.aborted) {
        return;
      }
      this.copyStatus.set({ blockIndex, code: block.text, text: 'Copied' });
    } catch {
      if (this.lifetime.signal.aborted) {
        return;
      }
      this.copyStatus.set({ blockIndex, code: block.text, text: 'Could not copy. Try again.' });
    }
  }
}
