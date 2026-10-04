import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { SharedStateKind } from '@opencrane/protocol';

// These aliases are presentation only; persisted events and HTTP states keep their names.
export type PresentationState = SharedStateKind | 'applying' | 'confirmed' | 'paused'
  | 'blocked' | 'refused' | 'removed' | 'waiting' | 'scheduled' | 'expired';

type StateGlyph = 'not_configured' | 'dot' | 'spinner' | 'check' | 'failed'
  | 'unknown' | 'access_changed' | 'paused' | 'block' | 'dash' | 'clock';

const REPEAT_ACTION_WORDS = /\b(?:retry|try\s+again)\b/iu;

const STATE_GLYPHS: Record<PresentationState, StateGlyph> = {
  not_configured: 'not_configured',
  draft: 'dot',
  needs_input: 'dot',
  checking: 'spinner',
  applying: 'spinner',
  ready: 'check',
  confirmed: 'check',
  failed: 'failed',
  unknown: 'unknown',
  access_changed: 'access_changed',
  paused: 'paused',
  blocked: 'block',
  refused: 'block',
  disabled: 'dash',
  removed: 'dash',
  waiting: 'clock',
  scheduled: 'clock',
  expired: 'clock',
};

@Component({
  selector: 'oc-shared-state',
  templateUrl: './shared-state.html',
  styleUrl: './shared-state.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SharedState {
  readonly kind = input.required<PresentationState>();
  readonly message = input.required<string>();
  readonly detail = input<string>();
  readonly actionLabel = input<string>();
  readonly safeToRetry = input(false);
  readonly showAction = input(true);
  readonly evidenceAt = input<string>();
  readonly timestamp = input<string>();
  readonly changeReference = input<string>();
  // Repeated rows stay silent. The operation's container normally owns announcements.
  readonly announce = input(false);
  readonly action = output<void>();

  protected readonly shownMessage = computed(this.stateMessage.bind(this));
  protected readonly glyph = computed(this.stateGlyph.bind(this));
  protected readonly shownAction = computed(this.actionText.bind(this));
  protected readonly evidenceTime = computed(this.formatEvidenceTime.bind(this));
  protected readonly stateTime = computed(this.formatStateTime.bind(this));

  private stateMessage(): string {
    if (this.kind() === 'failed' && this.safeToRetry() && this.message() === 'Failed') {
      return 'Failed — nothing changed';
    }
    return this.message();
  }

  private stateGlyph(): StateGlyph {
    return STATE_GLYPHS[this.kind()];
  }

  private actionText(): string | undefined {
    if (!this.showAction()) return undefined;
    if (this.glyph() === 'spinner') return undefined;
    if (this.kind() === 'unknown') return 'Check status';
    if (this.kind() === 'failed') {
      if (this.safeToRetry()) return 'Try again';
      return undefined;
    }
    const label = this.actionLabel();
    // Only an established safe failure can offer to repeat the operation.
    if (label && REPEAT_ACTION_WORDS.test(label)) return undefined;
    return label;
  }

  private formatEvidenceTime(): string | undefined {
    return this.formatTime(this.evidenceAt());
  }

  private formatStateTime(): string | undefined {
    return this.formatTime(this.timestamp());
  }

  private formatTime(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return undefined;
    const options: Intl.DateTimeFormatOptions = {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      timeZone: 'UTC', hourCycle: 'h23',
    };
    return `${date.toLocaleString('en-GB', options)} UTC`;
  }
}
