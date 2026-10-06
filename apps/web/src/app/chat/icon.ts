import { ChangeDetectionStrategy, Component, input } from '@angular/core';

// One stroked set for chat controls; the agent and Stop marks are deliberately filled.
@Component({ selector: 'oc-icon', changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    @switch (name()) {
      @case ('agent') { <path d="M3 13 7 2 14 13Z" fill="currentColor" stroke="none"/> }
      @case ('working') { <path d="M3 13 7 2 14 13Z" fill="currentColor" stroke="none"/> }
      @case ('done') { <path d="m3 8 3 3 7-7"/> }
      @case ('failed') { <path d="m4 4 8 8m0-8-8 8"/> }
      @case ('close') { <path d="m4 4 8 8m0-8-8 8"/> }
      @case ('closed') { <rect x="3" y="7" width="10" height="7" rx="2"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/> }
      @case ('clock') { <circle cx="8" cy="8" r="5.5"/><path d="M8 4.5V8l2.5 1.5"/> }
      @case ('block') { <circle cx="8" cy="8" r="5.5"/><path d="m4 4 8 8"/> }
      @case ('dash') { <path d="M3 8h10"/> }
      @case ('stop') { <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none"/> }
      @case ('stopped') { <rect x="4" y="4" width="8" height="8" rx="1.5"/> }
      @case ('plus') { <path d="M8 2v12M2 8h12"/> }
      @case ('send') { <path d="M8 13V3m-5 5 5-5 5 5"/> }
      @case ('menu') { <path d="M2 4h12M2 8h12M2 12h12"/> }
      @case ('upload') { <path d="M8 11V2m-3 3 3-3 3 3M2 10v4h12v-4"/> }
      @case ('folder') { <path d="M2 4h5l2 2h5v8H2Z"/> }
      @case ('settings') { <path d="m6 2-1 2-2 1v2L2 8l1 1v2l2 1 1 2h4l1-2 2-1V9l1-1-1-1V5l-2-1-1-2Z"/><circle cx="8" cy="8" r="2"/> }
      @case ('panel') { <rect x="2" y="2" width="12" height="12" rx="2"/><path d="M10 2v12"/> }
      @case ('chevron') { <path d="m6 3 5 5-5 5"/> }
      @default { <path d="M6 2 4 14M12 2l-2 12M2 6h12M2 10h12"/> }
    }
  </svg>`,
  styles: `:host{display:inline-flex;width:16px;height:16px;flex-shrink:0;vertical-align:middle}svg{width:100%;height:100%}`,
})
export class ChatIcon { readonly name = input(''); }
