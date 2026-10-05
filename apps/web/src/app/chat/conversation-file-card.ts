import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { DogEar } from '../ui/paper';
import { fileName, fileType, fileUrl, shortTime } from './file-presentation';

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
  readonly opened = output<string>();
  readonly filesOpened = output<void>();

  protected readonly name = computed(this.displayName.bind(this));
  protected readonly nameId = computed(this.fileNameId.bind(this));
  protected readonly type = computed(this.displayType.bind(this));
  protected readonly downloadUrl = computed(this.fileDownloadUrl.bind(this));

  protected open(): void {
    this.opened.emit(this.path());
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
}
