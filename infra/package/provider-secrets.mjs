import { chmod, chown, lstat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function makePrivate(path, directory, refusal) {
  const details = await lstat(path);
  if (details.isSymbolicLink() || details.isDirectory() !== directory ||
      (!directory && (!details.isFile() || details.nlink !== 1))) {
    throw new Error(refusal);
  }
  if (process.getuid() === 0) await chown(path, 1000, 1000);
  await chmod(path, directory ? 0o700 : 0o600);
}

async function prepareKeys(root, refusal) {
  const directory = join(root, 'keys');
  const directoryOptions = { recursive: true, mode: 0o700 };
  await mkdir(directory, directoryOptions);
  // Keep the volume root group-managed so a remount preserves the private child.
  await makePrivate(directory, true, refusal);
  return directory;
}

const root = process.argv[2];
if (root === '--directory-only') {
  const roots = process.argv.slice(3);
  if (roots.length === 0) throw new Error('Key custody root is required');
  // Leave files to their writers. A live memory write can briefly have two hard links.
  for (const keyRoot of roots) {
    await prepareKeys(keyRoot, 'Key custody must use a private directory');
  }
} else {
  if (!root) throw new Error('Provider custody root is required');
  const refusal = 'Provider custody must contain only private directories and files';
  const directory = await prepareKeys(root, refusal);
  for (const entry of await readdir(directory)) {
    await makePrivate(join(directory, entry), false, refusal);
  }
}
