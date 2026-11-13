import { readStorageLease } from '@opencrane/auth/storage-lease';
import { pathToFileURL } from 'node:url';

export async function objectLeaseReady(path) {
  try {
    await readStorageLease(path);
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!await objectLeaseReady('/run/storage/lease.json')) process.exitCode = 1;
}
