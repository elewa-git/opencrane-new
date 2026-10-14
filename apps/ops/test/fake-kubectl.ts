import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

export async function fakeKubectl(script = '') {
  const directory = await mkdtemp(`${tmpdir()}/kubectl-test-`);
  const previousPath = process.env['PATH'];
  const calls = `${directory}/calls`;
  const executable = `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$*" in
  *' get '*|*' delete '*|*'--dry-run=server'*) ;;
  *' replace '*|*' exec '*) cat > '${calls}.input' ;;
  *) cat >/dev/null ;;
esac
${script}
`;
  await writeFile(`${directory}/kubectl`, executable, { mode: 0o700 });
  process.env['PATH'] = `${directory}:${previousPath ?? ''}`;
  async function commands() {
    const output = await readFile(calls, 'utf8');
    const trimmed = output.trim();
    return trimmed.split('\n');
  }
  async function close() {
    process.env['PATH'] = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
  async function input(): Promise<unknown> {
    return JSON.parse(await readFile(`${calls}.input`, 'utf8'));
  }
  return { commands, close, input };
}
