import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { DogEar } from '../ui/paper';
import {
  capturedByLine, fileName, fileType, fileUrl, screenshotCaption, shortTime,
  type ScreenshotFacts,
} from './file-presentation';

@Component({
  selector: 'oc-conversation-file-card',
  imports: [DogEar],
  templateUrl: './conversation-file-card.html',
  styleUrl: './conversation-file-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConversationFileCard {
  readonly conversationId = input.required<string>();
  readonly path = input.required<string>();
  readonly createdAt = input.required<string>();
  readonly createdBy = input.required<'you' | 'participant' | 'assistant'>();
  readonly downloadAllowed = input(false);
  readonly thumbnailUrl = input('');
  readonly screenshot = input<ScreenshotFacts | undefined>();
  readonly opened = output<string>();
  readonly filesOpened = output<void>();

  protected readonly name = computed(this.displayName.bind(this));
  protected readonly nameId = computed(this.fileNameId.bind(this));
  protected readonly type = computed(this.displayType.bind(this));
  protected readonly downloadUrl = computed(this.fileDownloadUrl.bind(this));
  protected readonly thumbnailFailed = signal(false);
  private readonly attempt = signal(0);
  protected readonly caption = computed(this.screenshotCaption.bind(this));
  protected readonly capturedBy = computed(this.captureLine.bind(this));
  protected readonly thumbnailSource = computed(this.thumbnailPath.bind(this));
  protected readonly previewButtonLabel = computed(this.previewLabel.bind(this));
  protected readonly previewButtonName = computed(this.previewName.bind(this));

  protected open(): void {
    this.opened.emit(this.path());
  }

  protected retryThumbnail(): void {
    this.thumbnailFailed.set(false);
    this.attempt.update(value => value + 1);
  }

  protected previewAction(): void {
    if (this.thumbnailFailed()) {
      this.retryThumbnail();
      return;
    }
    this.open();
  }

  protected showFiles(): void {
    this.filesOpened.emit();
  }

  protected time(): string {
    return shortTime(this.createdAt());
  }

  private displayName(): string {
    return fileName(this.path());
  }

  private displayType(): string {
    return fileType(this.path());
  }

  private fileDownloadUrl(): string {
    return fileUrl(this.conversationId(), this.path());
  }

  private fileNameId(): string {
    const safePath = encodeURIComponent(this.path()).replaceAll('%', '-');
    return `file-name-${safePath}`;
  }

  private screenshotCaption(): string {
    const facts = this.screenshot();
    return facts ? screenshotCaption(facts.computerId) : '';
  }

  private captureLine(): string {
    const facts = this.screenshot();
    if (!facts) return '';
    return capturedByLine(this.createdBy(), facts);
  }

  private thumbnailPath(): string {
    const source = this.thumbnailUrl();
    if (!source || this.attempt() === 0) return source;
    return `${source}&attempt=${this.attempt()}`;
  }

  private previewLabel(): string {
    if (this.thumbnailFailed()) return 'Try preview again';
    return 'Open preview';
  }

  private previewName(): string {
    if (this.thumbnailFailed()) return `Try preview again for ${this.name()}`;
    return `Open preview of ${this.name()}`;
  }
}
