import type { IntegrationRow } from '@opencrane/protocol';

export function focusAccessHeading(): void {
  globalThis.document.getElementById('integration-access-heading')?.focus();
}

export function focusHeaderRefresh(): void {
  globalThis.document.getElementById('integration-refresh')?.focus();
}

export function findIntegrationRow(
  rows: readonly IntegrationRow[],
  serverId: string,
): IntegrationRow | undefined {
  for (const row of rows) {
    if (row.serverId === serverId) return row;
  }
  return undefined;
}
