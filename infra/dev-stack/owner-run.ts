export const ownerRunRefusal =
  'Owner commands require --owner-run, interactive stdin and no fleet task';

export function requireOwnerRun(explicit: boolean) {
  // Check before reading or changing owner data, even when a task has allocated a terminal.
  if (!explicit || !process.stdin.isTTY || process.env['OPENCRANE_FLEET_TASK'] !== undefined) {
    throw new Error(ownerRunRefusal);
  }
}
