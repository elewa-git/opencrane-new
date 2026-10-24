import { constants } from 'node:fs';
import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

const unavailable = 'Private key directory unavailable or unsafe';
async function checkDirectory(path: string) {
  const details = await lstat(path);
  if (!details.isDirectory() || details.uid !== process.getuid!()
    || (details.mode & 0o7777) !== 0o700 || await realpath(path) !== resolve(path)) {
    throw new Error(unavailable);
  }
  await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
}

/** Keep private keys in separate, owned directories; never repair existing permissions. */
export async function preparePrivateDirectories(directory: string, fresh: boolean,
  supplied: NodeJS.ProcessEnv = {}) {
  const settings = { PERSONAL_KEY_DIRECTORY: `${directory}/personal-keys`,
    MEMORY_KEY_DIRECTORY: `${directory}/memory-keys` };
  const missing: string[] = [];
  try {
    await checkDirectory(directory);
    for (const name of ['models', 'conversation-keys', 'provider-secrets']) {
      try {
        await checkDirectory(`${directory}/${name}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    for (const [name, path] of Object.entries(settings)) {
      if (supplied[name] !== undefined && supplied[name] !== path) {
        throw new Error(unavailable);
      }
      try {
        await checkDirectory(path);
      } catch (error) {
        if (!fresh || supplied[name] !== undefined
          || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        missing.push(path);
      }
    }
    // Validate both paths before creating either one. Supplied paths must already exist.
    for (const path of missing) {
      await mkdir(path, { mode: 0o700 });
      await checkDirectory(path);
    }
  } catch {
    // Keep filesystem paths and underlying errors out of logs and startup receipts.
    throw new Error(unavailable);
  }
  return settings;
}
