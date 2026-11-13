import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { BrowserSession } from '../core/browser-session';

@Component({
  selector: 'oc-sign-out',
  template: `
    <form method="post" action="/auth/logout" enctype="text/plain" (submit)="signOut()">
      <button type="submit" class="secondary">Sign out</button>
    </form>
  `,
  styles: `
    :host { display: block; }
    form { margin: 0; }
    button { width: 100%; font: inherit; font-size: 13px; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SignOut {
  private readonly session = inject(BrowserSession);

  protected signOut(): void {
    this.session.signOut();
  }
}
