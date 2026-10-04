export const organisationPages = [
  { id: 'overview', label: 'Overview', href: '/org/overview' },
  { id: 'people', label: 'People & groups', href: '/org/people' },
  { id: 'models', label: 'Models & providers', href: '/org/models' },
  { id: 'spending', label: 'Spending', href: '/org/spending' },
  { id: 'integrations', label: 'Integrations', href: '/org/integrations' },
  { id: 'routines', label: 'Routines', href: '/org/routines' },
  { id: 'history', label: 'Change history', href: '/org/history' },
] as const;

export type OrganisationPage = typeof organisationPages[number]['id'];

export function organisationPage(pathname: string): OrganisationPage | undefined {
  // Keep /org on a supported page until the overview has real task reads.
  if (pathname === '/org' || pathname === '/org/' || pathname === '/org/states') {
    return 'integrations';
  }
  for (const page of organisationPages) {
    if (pathname === page.href) {
      return page.id;
    }
  }
  if (pathname === '/org/integrations/new') {
    return 'integrations';
  }
  if (/^\/org\/integrations\/[\w-]+\/tools$/u.test(pathname)) {
    return 'integrations';
  }
  return undefined;
}
