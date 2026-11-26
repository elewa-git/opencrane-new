import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const exec = promisify(execFile);
const timerName = 'opencrane-scanner-refresh@';
const installer = 'install-scanner-refresh-timer.sh';

async function timerFixture(directory) {
  const worktree = join(directory, 'worktree');
  const stack = join(worktree, 'infra', 'dev-stack');
  const units = join(stack, 'systemd');
  const bin = join(directory, 'bin');
  const calls = join(directory, 'calls');
  const parents = { recursive: true };
  await mkdir(units, parents);
  await mkdir(bin);
  const origin = join(import.meta.dirname, '../infra/dev-stack');
  await copyFile(join(origin, installer), join(stack, installer));
  for (const kind of ['service', 'timer']) {
    const unit = `${timerName}.${kind}`;
    await copyFile(join(origin, 'systemd', unit), join(units, unit));
  }
  const executable = { mode: 0o755 };
  const fakeCommand = '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_CALLS"\n';
  await writeFile(join(bin, 'systemctl'), fakeCommand, executable);
  await writeFile(join(stack, 'run.sh'), fakeCommand, executable);
  const env = { HOME: directory, PATH: `${bin}:${process.env.PATH}`, TEST_CALLS: calls };
  return { worktree, stack, options: { env, cwd: directory }, calls };
}

async function registersOwnedTimer() {
  const directory = await mkdtemp(join(tmpdir(), 'scanner-timer-test-'));
  try {
    const fixture = await timerFixture(directory);
    const args = [join(fixture.stack, installer), '--id', '1'];
    await exec('/bin/sh', args, fixture.options);
    const schedule = join(directory, '.config', 'opencrane', 'scanner-refresh');
    expect(await readlink(join(schedule, '1'))).toBe(fixture.worktree);
    await expect(access(join(schedule, '2'))).rejects.toMatchObject({ code: 'ENOENT' });
    const units = join(directory, '.config', 'systemd', 'user');
    const timer = await readFile(join(units, `${timerName}.timer`), 'utf8');
    expect(timer).toContain('OnCalendar=*-*-* 00,12:00:00 UTC');
    expect(timer).toContain('Persistent=true');
    expect(timer).toContain('Unit=opencrane-scanner-refresh@%i.service');
    const service = await readFile(join(units, `${timerName}.service`), 'utf8');
    expect(service).toContain('WorkingDirectory=%h/.config/opencrane/scanner-refresh/%i');
    expect(service).toContain('ExecStart=/bin/sh infra/dev-stack/run.sh package-refresh-scanner --id %i');
    const calls = await readFile(fixture.calls, 'utf8');
    expect(calls).toBe('package-check --id 1\n--user daemon-reload\n' +
      '--user enable --now opencrane-scanner-refresh@1.timer\n');
  } finally {
    const cleanup = { recursive: true, force: true };
    await rm(directory, cleanup);
  }
}
test('installs the host schedule for the selected slot and enables its timer', registersOwnedTimer);
