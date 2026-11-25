import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendEvent, natsFixture } from '@opencrane/event-store/testing';
import { expect, it } from 'vitest';
import { providerEventDisclosureScript } from './provider-probe.ts';

const execute = promisify(execFile);
const fixtureName = 'Synthetic reader fixture';

async function scanEventHistory(needle: string) {
  const fixture = await natsFixture();
  try {
    const subject = 'member-alice';
    const data = { memberId: 'alice', email: 'alice@example.test', displayName: fixtureName,
      role: 'owner', invitationId: 'fixture-invitation' };
    await appendEvent(fixture.store, { silo: 'test', type: 'member.joined', subject, data });
    const args = ['--input-type=module', '-e', providerEventDisclosureScript];
    const pending = execute(process.execPath, args, { env: { ...process.env, ...fixture.env() } });
    if (!pending.child.stdin) throw new Error('The disclosure check needs private stdin');
    pending.child.stdin.end(JSON.stringify([needle]));
    return await pending;
  } finally {
    await fixture.close();
  }
}

async function countsCheckedEvents() {
  const result = await scanEventHistory('Different synthetic text');
  expect(JSON.parse(result.stdout)).toEqual({ checkedEvents: 1 });
  expect(result.stdout).not.toContain(fixtureName);
}
it('runs the private package command and counts real events', countsCheckedEvents);

async function refusesMatchingEventContent() {
  await expect(scanEventHistory(fixtureName)).rejects.toMatchObject({
    code: 1, stdout: '', stderr: expect.stringContaining('Credential in event'),
  });
}
it('refuses an event containing the supplied text without printing the event',
  refusesMatchingEventContent);
