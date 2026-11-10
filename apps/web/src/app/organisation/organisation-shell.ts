import {
  ChangeDetectionStrategy, Component, computed, effect, input, signal,
} from '@angular/core';
import { NavigationMenu } from '../ui/navigation-menu';
import { PaperSurface } from '../ui/paper';
import { BrandMark } from '../ui/brand-mark';
import { organisationPageLabel, organisationPages, type OrganisationPage } from './pages';

@Component({
  selector: 'oc-organisation-shell',
  imports: [NavigationMenu, PaperSurface, BrandMark],
  templateUrl: './organisation-shell.html',
  styleUrls: ['../ui/shell.css', './organisation-shell.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:resize)': 'resized()' },
})
export class OrganisationShell {
  readonly activePage = input<OrganisationPage>();
  readonly organisationName = input('Your organisation');
  readonly accessLost = input(false);
  readonly permittedPages = input<readonly OrganisationPage[] | undefined>();
  protected readonly pages = computed(() => {
    const permitted = this.permittedPages();
    if (this.accessLost()) return [];
    if (permitted === undefined) return organisationPages;
    return organisationPages.filter((page) => permitted.includes(page.id));
  });
  protected readonly menuOpen = signal(false);

  constructor() {
    effect(() => {
      if (this.accessLost() || this.pages().length === 0) this.menuOpen.set(false);
    });
  }

  protected pageLabel(): string {
    return organisationPageLabel(this.activePage()) ?? 'Organisation settings';
  }

  protected resized(): void {
    if (globalThis.innerWidth > 700) {
      this.menuOpen.set(false);
    }
  }
}
