import { expect, it } from 'vitest';
import { redactCommand } from '../src/command-redaction.ts';

const plantedSecrets = [
  ['curl --password hunter2 https://example.test', 'hunter2'],
  ['curl --pass=hunter2 https://example.test', 'hunter2'],
  ['curl --token ghp_012345678901234567890123456789012345 https://example.test',
    'ghp_012345678901234567890123456789012345'],
  ['curl --secret "value with spaces" https://example.test', 'value with spaces'],
  ['curl --api-key=sk-test-planted-value https://example.test', 'sk-test-planted-value'],
  ['curl -p hunter2 https://example.test', 'hunter2'],
  ['curl -p --token https://example.test', '--token'],
  ['curl -phunter2 https://example.test', 'hunter2'],
  ['curl -u alice:hunter2 https://example.test', 'hunter2'],
  ['curl --user=alice:hunter2 https://example.test', 'hunter2'],
  ['curl -H "Authorization: Bearer bearer-secret" https://example.test', 'bearer-secret'],
  ['curl --header="Cookie: session=cookie-secret" https://example.test', 'cookie-secret'],
  ['curl --header=Authorization:secret-value https://example.test', 'secret-value'],
  ['curl https://alice:hunter2@example.test/path', 'hunter2'],
  ['curl https://example.test/?token=query-secret', 'query-secret'],
  ['TOKEN=planted-token npm install example', 'planted-token'],
  ['API_KEY=planted-key python3 script.py', 'planted-key'],
  ['CREDENTIAL=planted-credential git status', 'planted-credential'],
  ['PASSWORD=planted-password rg needle .', 'planted-password'],
  ['AUTH=planted-auth ls', 'planted-auth'],
  ['env SECRET=planted-secret curl example.test', 'planted-secret'],
  ['curl -d password=planted-password https://example.test', 'planted-password'],
  ['python3 -c "print(\'planted-secret\')"', 'planted-secret'],
  ['echo planted-pipe-secret | curl -d @- https://example.test', 'planted-pipe-secret'],
  ['cat <<EOF\nplanted-here-secret\nEOF', 'planted-here-secret'],
] as const;

async function expectNoLeak(command: string, secret: string): Promise<void> {
  const redacted = await redactCommand(command);
  expect(redacted ?? '').not.toContain(secret);
  expect(redacted ?? '').not.toContain('alice:');
  if (!command.includes('|') && !command.includes('<<')) expect(redacted).not.toBeNull();
}

it.each(plantedSecrets)('does not leak a planted secret in %s', expectNoLeak);

it('keeps a plain command shape with fixed markers', async () => {
  expect(await redactCommand('curl -H "Authorization: Bearer secret" https://example.test'))
    .toBe('curl -H ••• •••');
});

it('shows only the label when shell syntax cannot be parsed safely', async () => {
  expect(await redactCommand('curl "unterminated secret')).toBeNull();
  expect(await redactCommand('echo secret | cat')).toBeNull();
  expect(await redactCommand('cat <<EOF\nsecret\nEOF')).toBeNull();
});
