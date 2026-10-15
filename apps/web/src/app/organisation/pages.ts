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
const peopleGroupPath = /^\/org\/people\/groups\/([\w-]{1,200})$/u;
const peopleMemberPath = /^\/org\/people\/members\/([\w-]{1,200})$/u;

export function peopleMemberId(pathname: string): string | undefined {
  return peopleMemberPath.exec(normalisePathname(pathname))?.[1];
}

const explanationPath = /^\/org\/integrations\/([^/]*)\/access\/explanation$/u;

export function toolExplanationServerId(pathname: string): string | undefined {
  return explanationPath.exec(normalisePathname(pathname))?.[1];
}

export function peopleGroupId(pathname: string): string | undefined {
  return peopleGroupPath.exec(normalisePathname(pathname))?.[1];
}

export function assistantCreateGroupId(pathname: string): string | undefined {
  const match = /^\/org\/people\/groups\/([\w-]{1,200})\/assistants\/new$/u
    .exec(normalisePathname(pathname));
  return match?.[1];
}

export function organisationPage(pathname: string): OrganisationPage | undefined {
  pathname = normalisePathname(pathname);
  // Keep /org on a supported page until the overview has real task reads.
  if (pathname === '/org') {
    return 'integrations';
  }
  for (const page of organisationPages) {
    if (pathname === page.href) {
      return page.id;
    }
  }
  if (pathname === '/org/people' || pathname === '/org/people/owners' ||
      peopleGroupId(pathname) !== undefined || peopleMemberId(pathname) !== undefined ||
      assistantCreateGroupId(pathname) !== undefined) {
    return 'people';
  }
  if (pathname === '/org/integrations/new') {
    return 'integrations';
  }
  if (toolExplanationServerId(pathname) !== undefined) {
    return 'integrations';
  }
  if (/^\/org\/integrations\/[\w-]+\/tools$/u.test(pathname)) {
    return 'integrations';
  }
  if (/^\/org\/integrations\/[\w-]+$/u.test(pathname)) {
    return 'integrations';
  }
  return undefined;
}

export function normalisePathname(pathname: string): string {
  return pathname.replace(/\/+$/u, '') || '/';
}

export function organisationPageLabel(pageId: OrganisationPage | undefined): string | undefined {
  for (const page of organisationPages) {
    if (page.id === pageId) {
      return page.label;
    }
  }
  return undefined;
}
