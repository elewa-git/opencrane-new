import { until } from '@opencrane/authz/testing';
import type { uploadComputer } from '../../server/test/support/upload-computer.ts';

type Computer = Awaited<ReturnType<typeof uploadComputer>>;

function isStoppedThread(state: string) {
  return state.startsWith('T');
}

export async function pauseBridgeCodex(computer: Computer) {
  const pid = await computer.exec('pgrep', '-u', '1000', '-x', 'codex');
  if (!/^\d+$/u.test(pid)) throw new Error('Expected one bridge Codex process');
  // Hold unrelated Codex workers still while the supervisor checks every task in /proc.
  // Leave executor users 1001 and 1003, the bridge and the desktop running.
  // Switch user here because failure fixtures replace setpriv and Python.
  const suspend = `
process.setgroups([]);
process.setgid(1000);
process.setuid(1000);
process.kill(Number(process.argv[1]), 'SIGSTOP');
`;
  await computer.exec('node', '--input-type=module', '-e', suspend, pid);

  async function allThreadsStopped() {
    const status = await computer.exec('ps', '-L', '--pid', pid, '-o', 'stat=');
    const states = status.split('\n');
    return states.every(isStoppedThread);
  }
  await until(allThreadsStopped);
  return pid;
}
