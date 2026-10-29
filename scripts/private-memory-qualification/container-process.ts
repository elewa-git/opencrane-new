import { execFileSync } from 'node:child_process';

function docker(args: string[], input = ''): unknown {
  const command = ['--host', 'unix:///var/run/docker.sock', ...args];
  const options = {
    encoding: 'utf8' as const, input, timeout: 120_000, killSignal: 'SIGKILL' as const,
    maxBuffer: 65_536, stdio: 'pipe' as const,
  };
  // Keep Docker errors and child output in memory; callers receive only a fixed refusal.
  const output = execFileSync('/usr/bin/docker', command, options);
  return JSON.parse(output) as unknown;
}

export function runInContainer(containerId: string, args: string[], input = ''): unknown {
  const settings = ['--workdir', '/app', '--env', 'NODE_OPTIONS=', '--env', 'NODE_PATH=',
    '--env', 'LD_PRELOAD='];
  return docker(['exec', ...settings, '-i', containerId, ...args], input);
}

