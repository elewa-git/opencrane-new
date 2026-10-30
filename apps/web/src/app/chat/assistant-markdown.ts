import {
  ChangeDetectionStrategy, Component, computed, input, output, signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { DogEar } from '../ui/paper';
import { parseMarkdown, type MarkdownBlock } from './markdown-parser';

@Component({
  selector: 'oc-assistant-markdown',
  imports: [NgTemplateOutlet, DogEar],
  templateUrl: './assistant-markdown.html',
  styleUrls: ['./transcript.css', './assistant-markdown.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssistantMarkdown {
  readonly text = input.required<string>();
  readonly citationOpened = output<string>();
  protected readonly blocks = computed(this.parseReply.bind(this));
  protected readonly copyStatus = signal<{ block: MarkdownBlock; text: string } | null>(null);

  private parseReply(): MarkdownBlock[] {
    return parseMarkdown(this.text());
  }

  protected async copyCode(block: MarkdownBlock): Promise<void> {
    try {
      await navigator.clipboard.writeText(block.text);
      this.copyStatus.set({ block, text: 'Copied' });
    } catch {
      this.copyStatus.set({ block, text: 'Could not copy. Try again.' });
    }
  }
}
