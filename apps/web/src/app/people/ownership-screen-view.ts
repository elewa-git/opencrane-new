import type { OwnershipChange, OwnershipOwner } from '@opencrane/protocol';

function ownershipMemberId(change: OwnershipChange | undefined): string {
  if (!change || typeof change.data['memberId'] !== 'string') return '';
  return change.data['memberId'];
}

export function ownershipRecordedAt(change: OwnershipChange | undefined): string {
  if (!change) return '';
  const date = new Date(change.recordedAt);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date) + ' UTC';
}

export function transferSuccessMessage(
  change: OwnershipChange | undefined,
  owners: OwnershipOwner[],
): string {
  const memberId = ownershipMemberId(change);
  const successor = owners.find(ownerMatchesMemberId(memberId));
  const displayName = successor?.displayName ?? memberId;
  return `${displayName} is now an owner`;
}

export function ownershipOwnerSummary(
  organisationName: string,
  ready: boolean,
  ownerCount: number,
): string {
  if (!ready) return `${organisationName} · ownership unavailable`;
  const noun = ownerCount === 1 ? 'owner' : 'owners';
  return `${organisationName} · ${ownerCount} ${noun}`;
}

function ownerMatchesMemberId(memberId: string): (owner: OwnershipOwner) => boolean {
  return (owner) => owner.memberId === memberId;
}
