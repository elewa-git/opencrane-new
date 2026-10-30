import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'oc-assistant-markdown',
  template: '{{ text() }}',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssistantMarkdown {
  readonly text = input.required<string>();
}
