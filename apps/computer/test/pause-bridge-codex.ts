import type { uploadComputer } from '../../server/test/support/upload-computer.ts';

type Computer = Awaited<ReturnType<typeof uploadComputer>>;

export async function pauseBridgeCodex(computer: Computer) {
  const pid = await computer.exec('pgrep', '-u', '1000', '-x', 'codex');
  if (!/^\d+$/u.test(pid)) throw new Error('Expected one bridge Codex process');
  return pid;
}
