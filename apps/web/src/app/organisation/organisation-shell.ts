import {
  ChangeDetectionStrategy, Component, input, signal,
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
  protected readonly pages = organisationPages;
  protected readonly menuOpen = signal(false);

  protected pageLabel(): string {
    return organisationPageLabel(this.activePage()) ?? 'Organisation settings';
  }

  protected resized(): void {
    if (globalThis.innerWidth > 700) {
      this.menuOpen.set(false);
    }
  }
}
