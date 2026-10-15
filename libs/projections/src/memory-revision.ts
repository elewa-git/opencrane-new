/** Keep the first write at an equal revision, including its expiry and saved position. */
export function shouldReplaceMemoryRevision(previousRevision: number | null | undefined,
  nextRevision: number | null): boolean {
  if (previousRevision === undefined || previousRevision === null) {
    return true;
  }
  return nextRevision !== null && nextRevision > previousRevision;
}
