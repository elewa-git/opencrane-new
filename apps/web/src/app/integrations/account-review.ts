import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { ToolPolicy } from '@opencrane/protocol';

export interface AccountReviewChoice {
  accountMode: 'none' | 'personal';
  identityTool?: string;
}

@Component({
  selector: 'oc-account-review',
  templateUrl: './account-review.html',
  styles: `fieldset { border: 1px solid var(--border, #d8d8d8); padding: 1rem;
    border-radius: .75rem; margin-block: 1rem; }
    label { display: block; min-height: 44px; margin-block: .75rem; }
    select { display: block; min-height: 44px; max-width: 100%; margin-top: .5rem; padding: .5rem; }
    p { max-width: 65ch; }`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountReview {
  readonly policy = input.required<ToolPolicy>();
  readonly disabled = input(false);
  readonly selected = output<AccountReviewChoice>();

  protected choose(accountMode: 'none' | 'personal'): void {
    this.selected.emit({ accountMode });
  }

  protected identityTools(): ToolPolicy['tools'] {
    const tools: ToolPolicy['tools'] = [];
    for (const tool of this.policy().tools) {
      if (tool.readOnly && tool.costCents === 0) tools.push(tool);
    }
    return tools;
  }

  protected identityChanged(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    this.selected.emit({ accountMode: 'personal', identityTool: target.value });
  }
}
