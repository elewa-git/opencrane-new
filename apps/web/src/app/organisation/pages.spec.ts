import { expect, it } from 'vitest';
import { assistantCreateGroupId, normalisePathname, organisationPage,
  organisationPageLabel, peopleMemberId } from './pages';

function checkTrailingSlash(pathname: string): void {
  expect(organisationPage(`${pathname}/`)).toBe(organisationPage(pathname));
  expect(normalisePathname(`${pathname}/`)).toBe(pathname);
}

const destinations = [
  '/org', '/org/integrations', '/org/integrations/new',
  '/org/integrations/server/tools', '/org/spending', '/org/models', '/org/people',
  '/org/people/groups/sales-team',
  '/org/people/owners',
];
it.each(destinations)(
  'retains the destination with a trailing slash at %s', checkTrailingSlash,
);

it('keeps integration detail inside the Integrations destination', () => {
  expect(organisationPage('/org/integrations/odoo')).toBe('integrations');
  expect(organisationPage('/org/integrations/new')).toBe('integrations');
});

it('keeps the shared assistant create page inside People & groups', () => {
  expect(assistantCreateGroupId('/org/people/groups/sales-team/assistants/new'))
    .toBe('sales-team');
  expect(organisationPage('/org/people/groups/sales-team/assistants/new')).toBe('people');
  expect(assistantCreateGroupId('/org/people/groups/sales-team/assistants/other'))
    .toBeUndefined();
});

it('opens the owner screen inside People & groups', () => {
  expect(organisationPage('/org/people/owners')).toBe('people');
});

it('routes a safe member id inside People & groups', () => {
  expect(peopleMemberId('/org/people/members/alex-kim')).toBe('alex-kim');
  expect(organisationPage('/org/people/members/alex-kim')).toBe('people');
  expect(peopleMemberId('/org/people/members/alex%40example.test')).toBeUndefined();
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
