import { Component } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { HingeDrawer } from '../src/app/ui/hinge-drawer';
import { ModalSheet } from '../src/app/ui/modal-sheet';

// Standalone shared-panel captures qualify the desktop frames that chat opens only on phones.
@Component({
  selector: 'app-root',
  imports: [HingeDrawer, ModalSheet],
  template: `<main><h1>Shared overlay visual fixture</h1></main>
    @if (drawer) {
      <oc-hinge-drawer [open]="true" title="Remove access" backLabel="Cancel">
        <p>Review the people who will lose access before confirming.</p>
        <button overlayFooter type="button">Remove access</button>
      </oc-hinge-drawer>
    } @else {
      <oc-modal-sheet [open]="true" title="Review before publishing" backLabel="Cancel">
        <p>Review the people and tools before publishing.</p>
        <button overlayFooter type="button">Publish</button>
      </oc-modal-sheet>
    }`,
})
class OverlayVisualHost {
  protected readonly drawer = location.search === '?drawer';
}

function reportFailure(error: unknown): void {
  console.error(error);
}

void bootstrapApplication(OverlayVisualHost).catch(reportFailure);
