import type { GroupRow } from '@opencrane/protocol';

type Grant = GroupRow['access']['grants'][number];

export function sourceLabel(source: 'local' | 'identity_provider'): string {
  if (source === 'local') return 'Local · managed in OpenCrane';
  return 'Supplied by your identity provider';
}

export function memberCountLabel(count: number): string {
  if (count === 1) return '1 member';
  return `${count} members`;
}

export function grantCountLabel(count: number): string {
  if (count === 1) return '1 grant';
  return `${count} grants`;
}

export function grantResourceLabel(resourceType: string): string {
  if (resourceType === 'mcp_server') return 'integration';
  if (resourceType === 'model') return 'model';
  if (resourceType === 'assistant') return 'assistant';
  return resourceType;
}

export function sharedAssistantIds(grants: Grant[]): string[] {
  const assistants = grants.filter(isSharedAssistant);
  const assistantIds = assistants.map(resourceId);
  return assistantIds;
}

function isSharedAssistant(grant: Grant): boolean {
  return grant.relation === 'acts_for' && grant.resourceType === 'assistant';
}

function resourceId(grant: Grant): string {
  return grant.resourceId;
}

export function useGrants(grants: Grant[]): Grant[] {
  return grants.filter(isUseGrant);
}

function isUseGrant(grant: Grant): boolean {
  return grant.relation === 'use';
}

export function isDuplicateName(name: string, rows: GroupRow[]): boolean {
  const key = name.trim().toLocaleLowerCase('en-GB');
  for (const row of rows) {
    const existingName = row.name.trim().toLocaleLowerCase('en-GB');
    if (existingName === key) return true;
  }
  return false;
}

export function newGroupId(name: string): string {
  const lowerName = name.toLowerCase();
  const hyphenatedName = lowerName.replace(/[^a-z0-9]+/gu, '-');
  const trimmedName = hyphenatedName.replace(/^-|-$/gu, '');
  const readableName = trimmedName.slice(0, 40);
  let idPrefix = readableName;
  if (!idPrefix) idPrefix = 'group';
  const randomUuid = crypto.randomUUID();
  const uuidWithoutHyphens = randomUuid.replaceAll('-', '');
  const shortUuid = uuidWithoutHyphens.slice(0, 8);
  return `${idPrefix}-${shortUuid}`;
}

export function compareByDisplayName(left: GroupRow['members'][number],
  right: GroupRow['members'][number]): number {
  return left.displayName.localeCompare(right.displayName, 'en-GB');
}

export function checkTimeLabel(checkedAt: string): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC',
  };
  return new Date(checkedAt).toLocaleTimeString('en-GB', options);
}
