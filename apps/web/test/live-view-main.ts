import { Component } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { LiveView } from '../src/app/live-view/live-view';

// Browser qualification host; the product session panel will mount LiveView after P2-5.
@Component({ selector: 'app-root', imports: [LiveView],
  template: '<main style="max-width:1000px;margin:auto;padding:16px"><oc-live-view conversationId="chat" /></main>' })
class LiveViewHost {}

void bootstrapApplication(LiveViewHost).catch((error: unknown) => console.error(error));
