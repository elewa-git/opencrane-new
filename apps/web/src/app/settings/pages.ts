import { normalisePathname } from '../organisation/pages';

export const personalSettingsPages = [
  { id: 'account', label: 'Account', href: '/account' },
  { id: 'preferences', label: 'Preferences', href: '/account/preferences' },
  { id: 'assistant', label: 'Assistant', href: '/account/assistant' },
  { id: 'tools', label: 'My tools', href: '/account/tools' },
] as const;

export type PersonalSettingsPage = typeof personalSettingsPages[number]['id'];

export function personalSettingsPage(pathname: string): PersonalSettingsPage | undefined {
  const normalisedPathname = normalisePathname(pathname);
  for (const page of personalSettingsPages) {
    if (page.href === normalisedPathname) {
      return page.id;
    }
  }
  return undefined;
}

export function personalSettingsPageLabel(pageId: PersonalSettingsPage | undefined): string {
  for (const page of personalSettingsPages) {
    if (page.id === pageId) {
      return page.label;
    }
  }
  return 'Personal settings';
}
