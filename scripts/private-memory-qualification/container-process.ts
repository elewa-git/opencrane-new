import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export async function runInContainer(
  containerId: string, args: string[], input = '',
): Promise<unknown> {
  const sourceUrl = new URL('./supervisor.mjs', import.meta.url);
  const source = await readFile(sourceUrl, 'utf8');
  const settings = ['--workdir', '/app', '--env', 'NODE_OPTIONS=', '--env', 'NODE_PATH=',
    '--env', 'LD_PRELOAD='];
  const command = ['--host', 'unix:///var/run/docker.sock', 'exec', ...settings, '-i',
    containerId, '/usr/local/bin/node', '--input-type=module', '--eval', source,
    JSON.stringify(args)];
  const output = await attachedProcess(command, input);
  return JSON.parse(output) as unknown;
}

function attachedProcess(command: string[], input: string): Promise<string> {
  function execute(resolve: (output: string) => void, reject: (error: Error) => void): void {
    const options = { stdio: 'pipe' as const };
    const child = spawn('/usr/bin/docker', command, options);
    const chunks: Buffer[] = [];
    let size = 0;
    // Give the in-container deadline time to kill and reap the journey first.
    const deadline = setTimeout(cancel, 130_000);
    function cancel(): void {
      child.stdin.destroy();
      child.kill('SIGKILL');
    }
    function failed(): void {
      clearTimeout(deadline);
      reject(new Error('container_process_failed'));
    }
    function stdout(buffer: Buffer): void {
      size += buffer.length;
      if (size > 65_536) {
        cancel();
        return;
      }
      chunks.push(buffer);
    }
    function stderr(buffer: Buffer): void {
      size += buffer.length;
      if (size > 65_536) {
        cancel();
      }
    }
    function closed(code: number | null): void {
      clearTimeout(deadline);
      child.stdin.destroy();
      if (code !== 0 || size > 65_536) {
        failed();
        return;
      }
      const buffer = Buffer.concat(chunks);
      const output = buffer.toString('utf8');
      resolve(output);
    }
    child.on('error', failed);
    child.on('close', closed);
    child.stdout.on('data', stdout);
    child.stderr.on('data', stderr);
    child.stdin.on('error', cancel);
    // Keep stdin open until Docker exits. Collector exit closes it and cancels the supervisor.
    child.stdin.write(`${JSON.stringify(input)}\n`);
  }
  return new Promise(execute);
}
