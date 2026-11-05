import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

async function signOutInAnotherTab(): Promise<void> {
  const options = {
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    timeout: 240_000,
  };
  const execute = promisify(execFile);
  const argumentsList = ['scripts/check-private-reply-signout.mjs'];
  const result = await execute(process.execPath, argumentsList, options);
  expect(result.stdout).toContain('PASS two-tab sign-out and return-time session checks in Chromium');
  const retentionArguments = ['scripts/check-private-reply-retention.mjs'];
  const retention = await execute(process.execPath, retentionArguments, options);
  expect(retention.stdout).toContain('PASS cleared private copies and diagrams are collectible');
  const displayArguments = ['scripts/capture-p4-15-pr3l.mjs', '--development'];
  const display = await execute(process.execPath, displayArguments, options);
  expect(display.stdout).toContain('PASS private reply display, clearance and captures');
}

it('clears private replies when another tab signs out, including a missed notification',
  signOutInAnotherTab, 250_000);
