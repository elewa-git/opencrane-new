import { readFile } from 'node:fs/promises';

export async function dispatcherReady(file: string, pid: number | undefined): Promise<boolean> {
  if (!pid) return false;
  try {
    const readyPid = (await readFile(file, 'utf8')).trim();
    return readyPid === String(pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
