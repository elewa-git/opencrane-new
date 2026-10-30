import { Directive, ElementRef, computed, inject, input, output, signal } from '@angular/core';

@Directive({
  selector: '[ocFileDrop]',
  exportAs: 'ocFileDrop',
  host: {
    '(dragenter)': 'enter($event)',
    '(dragover)': 'over($event)',
    '(dragleave)': 'leave()',
    '(drop)': 'drop($event)',
    '(document:dragover)': 'outside($event)',
    '(document:drop)': 'preventFileNavigation($event)',
    '(document:dragend)': 'reset()',
    '(window:blur)': 'reset()',
    '(window:resize)': 'resize()',
  },
})
export class FileDrop {
  readonly enabled = input(false, { alias: 'ocFileDrop' });
  readonly filesDropped = output<File[]>();
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly wide = signal(globalThis.innerWidth > 700);
  private readonly dragging = signal(false);
  readonly active = computed(this.isActive.bind(this));
  private depth = 0;

  private isActive(): boolean {
    return this.dragging() && this.enabled() && this.wide();
  }

  protected enter(event: DragEvent): void {
    if (!this.accepts(event)) return;
    event.preventDefault();
    this.depth += 1;
    this.dragging.set(true);
  }

  protected over(event: DragEvent): void {
    if (!this.accepts(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.depth = Math.max(1, this.depth);
    this.dragging.set(true);
  }

  protected leave(): void {
    this.depth = Math.max(0, this.depth - 1);
    if (this.depth === 0) this.reset();
  }

  protected drop(event: DragEvent): void {
    const accepted = this.accepts(event);
    this.preventFileNavigation(event);
    if (!accepted || !event.dataTransfer) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) this.filesDropped.emit(files);
  }

  protected outside(event: DragEvent): void {
    if (!hasFiles(event)) return;
    event.preventDefault();
    const target = event.target;
    if (!this.accepts(event) || !(target instanceof Node)
      || !this.element.nativeElement.contains(target)) {
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
      this.reset();
    }
  }

  protected preventFileNavigation(event: DragEvent): void {
    if (hasFiles(event)) event.preventDefault();
    this.reset();
  }

  protected reset(): void {
    this.depth = 0;
    this.dragging.set(false);
  }

  protected resize(): void {
    this.wide.set(globalThis.innerWidth > 700);
    this.reset();
  }

  private accepts(event: DragEvent): boolean {
    return this.enabled() && this.wide() && hasFiles(event);
  }
}

function hasFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types ?? [];
  return Array.from(types).includes('Files');
}
