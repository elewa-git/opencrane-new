import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

async function recordedDispatcherPid(markerFile: string): Promise<number | undefined> {
  const processFile = join(dirname(markerFile), 'dispatcher.pid');
  const record = (await readFile(processFile, 'utf8')).trim();
  const [pidText, recordedStart] = record.split(' ');
  if (!pidText || !/^[1-9][0-9]*$/.test(pidText) || !recordedStart ||
      !/^[0-9]+$/.test(recordedStart)) return undefined;
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid)) return undefined;
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  if (fields[0] === 'Z' || fields[19] !== recordedStart) return undefined;
  return pid;
}

/** Read the private dev stack marker. Production has no marker and reports ready. */
export async function dispatcherReady(file: string | undefined): Promise<boolean> {
  if (!file) return true;
  try {
    const text = (await readFile(file, 'utf8')).trim();
    if (!/^[1-9][0-9]*$/.test(text)) return false;
    const pid = Number(text);
    if (!Number.isSafeInteger(pid)) return false;
    // Match the stack's process start record so a reused PID cannot hide an outage.
    const currentPid = await recordedDispatcherPid(file);
    return pid === currentPid;
  } catch {
    // Treat missing or stale markers as waiting without showing server details to members.
    return false;
  }
}
