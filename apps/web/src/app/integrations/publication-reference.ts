import { recordIdPattern } from '@opencrane/protocol';
const publicationStoragePrefix = 'integration-publication:';

export function isPublicationIdentifier(value: unknown): value is string {
  return typeof value === 'string' && recordIdPattern.test(value);
}

export function readStoredPublication(serverId: string): string {
  try {
    const stored = sessionStorage.getItem(publicationStoragePrefix + serverId);
    if (isPublicationIdentifier(stored)) return stored;
    if (stored !== null) removeStoredPublication(serverId);
  } catch {
    // Keep the page usable when browser storage is blocked.
  }
  return '';
}

export function storePublication(serverId: string, commandId: string): void {
  try {
    sessionStorage.setItem(publicationStoragePrefix + serverId, commandId);
  } catch {
    // Keep the reference in memory while this page is open.
  }
}

export function removeStoredPublication(serverId: string): void {
  try {
    sessionStorage.removeItem(publicationStoragePrefix + serverId);
  } catch {
    // The page still clears its in-memory reference.
  }
}
