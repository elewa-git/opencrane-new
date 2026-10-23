import { readFile, realpath } from 'node:fs/promises';

export async function requireStageBStack(requested: string | undefined, claimed: string,
  home: string, worktree: string) {
  if ((requested !== '1' && requested !== '2') || claimed !== requested) {
    throw new Error('Secondary slot mismatch');
  }
  const directory = `${home}/.config/opencrane/dev-stack-${requested}`;
  if (await realpath(directory) !== directory) throw new Error('Foreign stack');
  const marker = await readFile(`${directory}/stack-owner`, 'utf8');
  let owner = marker;
  if (marker.startsWith('worktree=')) {
    const lines = marker.split('\n');
    owner = lines[0]!.slice('worktree='.length);
  }
  if (owner !== worktree) throw new Error('Foreign stack');
  return directory;
}
