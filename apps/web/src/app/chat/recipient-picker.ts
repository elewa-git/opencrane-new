import {
  ChangeDetectionStrategy, Component, ElementRef, afterEveryRender, input, output, viewChild,
} from '@angular/core';

export type Colleague = { memberId: string; displayName: string | null };

@Component({
  selector: 'oc-recipient-picker',
  templateUrl: './recipient-picker.html',
  styleUrl: './recipient-picker.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecipientPicker {
  readonly searchState = input<'idle' | 'loading' | 'ready' | 'failed'>('ready');
  readonly colleagues = input.required<Colleague[]>();
  readonly query = input.required<string>();
  readonly selected = input<Colleague | undefined>();
  readonly draft = input(false);
  readonly disabled = input(false);
  readonly queryEdited = output<string>();
  readonly recipientSelected = output<Colleague>();
  readonly recipientChanged = output<void>();
  private readonly searchField = viewChild<ElementRef<HTMLInputElement>>('searchField');
  private focusSearch = false;

  constructor() {
    afterEveryRender(this.restoreFocus.bind(this));
  }

  protected queryChanged(event: Event): void {
    const field = event.target;
    if (!(field instanceof HTMLInputElement)) return;
    this.queryEdited.emit(field.value);
  }

  protected select(colleague: Colleague): void {
    this.recipientSelected.emit(colleague);
  }

  protected change(): void {
    this.recipientChanged.emit();
    this.focusSearch = true;
  }

  protected displayName(colleague: Colleague): string {
    return colleague.displayName?.trim() || colleague.memberId;
  }

  private restoreFocus(): void {
    if (!this.focusSearch) return;
    this.focusSearch = false;
    requestAnimationFrame(this.focusSearchField.bind(this));
  }

  private focusSearchField(): void {
    this.searchField()?.nativeElement.focus();
  }
}
