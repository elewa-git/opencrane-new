import { expect, it } from 'vitest';
import { normalisePathname, organisationPage, organisationPageLabel } from './pages';

function checkTrailingSlash(pathname: string): void {
  expect(organisationPage(`${pathname}/`)).toBe(organisationPage(pathname));
  expect(normalisePathname(`${pathname}/`)).toBe(pathname);
}

const destinations = [
  '/org', '/org/integrations', '/org/integrations/new',
  '/org/integrations/server/tools', '/org/spending', '/org/models', '/org/people',
  '/org/people/groups/sales-team',
];
it.each(destinations)(
  'retains the destination with a trailing slash at %s', checkTrailingSlash,
);

it('keeps integration detail inside the Integrations destination', () => {
  expect(organisationPage('/org/integrations/odoo')).toBe('integrations');
  expect(organisationPage('/org/integrations/new')).toBe('integrations');
});

function checkNonNavigationPages(): void {
  expect(organisationPage('/org/states')).toBeUndefined();
  expect(organisationPage('/org/missing')).toBeUndefined();
  expect(organisationPage('/org/people/groups')).toBeUndefined();
  expect(organisationPage('/org/people/groups/' + 'x'.repeat(201))).toBeUndefined();
  expect(organisationPageLabel(undefined)).toBeUndefined();
  expect(normalisePathname('/')).toBe('/');
}

it('does not select an unrelated destination for the state specimen or unknown pages',
  checkNonNavigationPages);
