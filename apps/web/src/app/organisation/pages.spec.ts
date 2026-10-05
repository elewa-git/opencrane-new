import { expect, it } from 'vitest';
import { normalisePathname, organisationPage, organisationPageLabel } from './pages';

function checkTrailingSlash(pathname: string): void {
  expect(organisationPage(`${pathname}/`)).toBe(organisationPage(pathname));
  expect(normalisePathname(`${pathname}/`)).toBe(pathname);
}

const destinations = [
  '/org', '/org/integrations', '/org/integrations/new',
  '/org/integrations/server/tools', '/org/spending', '/org/models',
];
it.each(destinations)(
  'retains the destination with a trailing slash at %s', checkTrailingSlash,
);

function checkNonNavigationPages(): void {
  expect(organisationPage('/org/states')).toBeUndefined();
  expect(organisationPage('/org/missing')).toBeUndefined();
  expect(organisationPageLabel(undefined)).toBeUndefined();
  expect(normalisePathname('/')).toBe('/');
}

it('does not select an unrelated destination for the state specimen or unknown pages',
  checkNonNavigationPages);
