import { chmod, chown, lstat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function makePrivate(path, directory, refusal) {
  const details = await lstat(path);
  if (details.isSymbolicLink() || details.isDirectory() !== directory ||
      (!directory && (!details.isFile() || details.nlink !== 1))) {
    throw new Error(refusal);
  }
  if (process.getuid() === 0) {
    await chown(path, 1000, 1000);
  }
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

async function verifyMemberKey(directory, entry, refusal) {
  const path = join(directory, entry);
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    // A running writer can remove its temporary name before the check reaches it.
    if (error.code === 'ENOENT' && /(?:-pending|\.pending|-deleting-[a-f0-9-]+)$/u.test(entry)) {
      return;
    }
    throw new Error(refusal, { cause: error });
  }
  const owner = process.getuid() === 0 ? 1000 : process.getuid();
  if (!details.isFile() || details.uid !== owner || (details.mode & 0o7777) !== 0o600) {
    throw new Error(refusal);
  }
}

async function prepareMemberKeys(root) {
  const refusal = 'Key custody must use a private directory and owner-only files';
  const directory = await prepareKeys(root, refusal);
  for (const entry of await readdir(directory)) {
    // Check both names when Memory briefly links a complete key before removing its old name.
    await verifyMemberKey(directory, entry, refusal);
  }
}

const root = process.argv[2];
if (root === '--directory-only') {
  const roots = process.argv.slice(3);
  if (roots.length === 0) {
    throw new Error('Key custody root is required');
  }
  for (const keyRoot of roots) {
    await prepareMemberKeys(keyRoot);
  }
} else {
  if (!root) {
    throw new Error('Provider custody root is required');
  }
  const refusal = 'Provider custody must contain only private directories and files';
  const directory = await prepareKeys(root, refusal);
  for (const entry of await readdir(directory)) {
    await makePrivate(join(directory, entry), false, refusal);
  }
}
