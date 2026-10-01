import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { SharedStateKind } from '@opencrane/protocol';

@Component({
  selector: 'oc-shared-state',
  templateUrl: './shared-state.html',
  styleUrl: './shared-state.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SharedState {
  readonly kind = input.required<SharedStateKind>();
  readonly message = input.required<string>();
  readonly detail = input<string>();
  readonly actionLabel = input<string>();
  readonly safeToRetry = input(false);
  readonly showAction = input(true);
  readonly action = output<void>();

  protected readonly shownAction = computed(() => {
    if (!this.showAction()) return undefined;
    if (this.kind() === 'checking') return undefined;
    if (this.kind() === 'unknown') return 'Check status';
    if (this.kind() === 'failed') return this.safeToRetry() ? 'Try the same change again' : undefined;
    return this.actionLabel();
  });
}
