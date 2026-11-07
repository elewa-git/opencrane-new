import { readFile } from 'node:fs/promises';

/** Read the private dev stack marker. Production has no marker and reports ready. */
export async function dispatcherReady(file: string | undefined): Promise<boolean> {
  if (!file) return true;
  try {
    const text = (await readFile(file, 'utf8')).trim();
    if (!/^[1-9][0-9]*$/.test(text)) return false;
    const pid = Number(text);
    if (!Number.isSafeInteger(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    // Treat missing or stale markers as waiting without showing server details to members.
    return false;
  }
}
