import {
  ChangeDetectionStrategy, Component, input, signal,
} from '@angular/core';
import { NavigationMenu } from '../ui/navigation-menu';
import { PaperSurface } from '../ui/paper';
import { organisationPageLabel, organisationPages, type OrganisationPage } from './pages';

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
