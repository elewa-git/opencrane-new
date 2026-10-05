import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { DogEar } from '../ui/paper';

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
  readonly thumbnailUrl = input('');
  readonly opened = output<string>();
  readonly downloaded = output<string>();
  readonly filesOpened = output<void>();

  protected readonly name = computed(this.fileName.bind(this));
  protected readonly type = computed(this.fileType.bind(this));
  protected readonly downloadUrl = computed(this.authorisedDownloadUrl.bind(this));

  protected open(): void {
    this.opened.emit(this.path());
  }

  protected markDownloaded(): void {
    this.downloaded.emit(this.path());
  }

  protected showFiles(): void {
    this.filesOpened.emit();
  }

  protected time(): string {
    const date = new Date(this.createdAt());
    return date.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private fileName(): string {
    const path = this.path();
    const parts = path.split('/');
    return parts.at(-1) ?? path;
  }

  private fileType(): string {
    const fileName = this.name();
    const parts = fileName.split('.');
    const extension = parts.at(-1) ?? 'FILE';
    return extension.toUpperCase().slice(0, 5);
  }

  private authorisedDownloadUrl(): string {
    const conversation = encodeURIComponent(this.conversationId());
    const path = encodeURIComponent(this.path());
    return `/api/conversations/${conversation}/files/view?path=${path}`;
  }
}
