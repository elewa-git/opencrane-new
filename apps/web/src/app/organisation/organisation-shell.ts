import {
  ChangeDetectionStrategy, Component, input, signal,
} from '@angular/core';
import { NavigationMenu } from '../ui/navigation-menu';
import { PaperSurface } from '../ui/paper';
import { organisationPages, type OrganisationPage } from './pages';

interface NavigationAccess {
  readonly page: OrganisationPage;
  readonly visible: boolean;
  readonly readOnly?: boolean;
}

@Component({
  selector: 'oc-organisation-shell',
  imports: [NavigationMenu, PaperSurface],
  templateUrl: './organisation-shell.html',
  styleUrl: './organisation-shell.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:resize)': 'resized()' },
})
export class OrganisationShell {
  readonly activePage = input<OrganisationPage>();
  readonly organisationName = input('Your organisation');
  readonly viewer = input<string>();
  // These are server-supported display hints, never permission to read a destination.
  readonly navigationAccess = input<readonly NavigationAccess[]>([]);
  readonly attentionCount = input<number>();
  protected readonly pages = organisationPages;
  protected readonly menuOpen = signal(false);

  protected visible(page: OrganisationPage): boolean {
    for (const access of this.navigationAccess()) {
      if (access.page === page) {
        return access.visible;
      }
    }
    return true;
  }

  protected readOnly(page: OrganisationPage): boolean {
    for (const access of this.navigationAccess()) {
      if (access.page === page) {
        return access.readOnly === true;
      }
    }
    return false;
  }

  protected pageLabel(): string {
    for (const page of this.pages) {
      if (page.id === this.activePage()) {
        return page.label;
      }
    }
    return 'Organisation settings';
  }

  protected resized(): void {
    if (globalThis.innerWidth > 700) {
      this.menuOpen.set(false);
    }
  }
}
