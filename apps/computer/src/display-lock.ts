import { chmodSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isDisplayOneServer(processRoot: string, pid: number): boolean {
  const processDirectory = `${processRoot}/${pid}`;
  const processName = readFileSync(`${processDirectory}/comm`, 'utf8').trim();
  const commandLine = readFileSync(`${processDirectory}/cmdline`, 'utf8');
  const argumentsList = commandLine.split('\0');
  return processName === 'Xvnc' && argumentsList.includes(':1');
}

export function removeStaleDisplayLock(lockPath: string, processRoot = '/proc'): void {
  let contents: string;
  try {
    contents = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }

  const pid = Number(contents.trim());
  if (!Number.isSafeInteger(pid) || pid < 1) {
    unlinkSync(lockPath);
    return;
  }

  try {
    if (isDisplayOneServer(processRoot, pid)) return;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  unlinkSync(lockPath);
}

export function prepareDisplaySocketDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
  // Let other users connect to the display socket, but stop them creating files here.
  chmodSync(path, 0o711);
}

export function restrictDisplaySocketDirectory(path: string): void {
  chmodSync(path, 0o711);
}
