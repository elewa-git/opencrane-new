import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { NavigationMenu } from '../ui/navigation-menu';
import { PaperSurface } from '../ui/paper';
import { personalSettingsPages, personalSettingsPageLabel, type PersonalSettingsPage } from './pages';

@Component({
  selector: 'oc-personal-settings-shell',
  imports: [NavigationMenu, PaperSurface],
  templateUrl: './personal-settings-shell.html',
  styleUrl: './personal-settings-shell.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:resize)': 'resized()' },
})
export class PersonalSettingsShell {
  readonly activePage = input.required<PersonalSettingsPage>();
  protected readonly pages = personalSettingsPages;
  protected readonly menuOpen = signal(false);

  protected pageLabel(): string {
    return personalSettingsPageLabel(this.activePage());
  }

  protected resized(): void {
    if (globalThis.innerWidth > 700) {
      this.menuOpen.set(false);
    }
  }
}
