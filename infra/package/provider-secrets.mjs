import { chmod, chown, lstat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function makePrivate(path, directory) {
  const details = await lstat(path);
  if (details.isSymbolicLink() || details.isDirectory() !== directory ||
      (!directory && (!details.isFile() || details.nlink !== 1))) {
    throw new Error('Provider custody must contain only private directories and files');
  }
  if (process.getuid() === 0) await chown(path, 1000, 1000);
  await chmod(path, directory ? 0o700 : 0o600);
}

const root = process.argv[2];
if (!root) throw new Error('Provider custody root is required');
const directory = join(root, 'keys');
await mkdir(directory, { recursive: true, mode: 0o700 });
// Keep the volume root group-managed. OnRootMismatch then preserves private children on remount.
// Run before either process starts; no other workload mounts this custody volume.
await makePrivate(directory, true);
for (const entry of await readdir(directory)) {
  await makePrivate(join(directory, entry), false);
}
