import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { NavigationMenu } from '../ui/navigation-menu';
import { PaperSurface } from '../ui/paper';
import { BrandMark } from '../ui/brand-mark';
import {
  personalSettingsPages, personalSettingsPageLabel, type PersonalSettingsPage,
} from './pages';

@Component({
  selector: 'oc-personal-settings-shell',
  imports: [NavigationMenu, PaperSurface, BrandMark],
  templateUrl: './personal-settings-shell.html',
  styleUrls: ['../ui/shell.css', './personal-settings-shell.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:resize)': 'resized()' },
})
export class PersonalSettingsShell {
  readonly activePage = input<PersonalSettingsPage>();
  protected readonly pages = personalSettingsPages;
  protected readonly menuOpen = signal(false);

  protected pageLabel(): string {
    if (!this.activePage()) {
      return 'Settings';
    }
    return personalSettingsPageLabel(this.activePage());
  }

  protected resized(): void {
    if (globalThis.innerWidth > 700) {
      this.menuOpen.set(false);
    }
  }
}
