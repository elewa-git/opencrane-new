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
  ['curl -p --pass --token https://example.test', '--token'],
  ['curl -p --user --password https://example.test', '--password'],
  ['curl -p -u --password https://example.test', '--password'],
  ['env curl -p --pass --token https://example.test', '--token'],
  ['curl --pass --token https://example.test', '--token'],
  ['curl -s --pass --token https://example.test', '--token'],
  ['curl -s --user --password https://example.test', '--password'],
  ['curl --unknown --pass --token https://example.test', '--token'],
  ['curl -phunter2 https://example.test', 'hunter2'],
  ['curl -u alice:hunter2 https://example.test', 'hunter2'],
  ['curl --user=alice:hunter2 https://example.test', 'hunter2'],
  ['curl -H "Authorization: Bearer bearer-secret" https://example.test', 'bearer-secret'],
  ['curl --header="Cookie: session=cookie-secret" https://example.test', 'cookie-secret'],
  ['curl --header=Authorization:secret-value https://example.test', 'secret-value'],
  ['curl https://alice:hunter2@example.test/path', 'hunter2'],
  ['git clone https://alice:hunter2@example.test/repo', 'hunter2'],
  ['curl https://example.test/?token=query-secret', 'query-secret'],
  ['curl --token xoxb-123456789012-123456789012-abcdef https://example.test',
    'xoxb-123456789012-123456789012-abcdef'],
  ['curl --token dGhpcy1pcy1hLXBsYW50ZWQtc2VjcmV0 https://example.test',
    'dGhpcy1pcy1hLXBsYW50ZWQtc2VjcmV0'],
  ['TOKEN=planted-token npm install example', 'planted-token'],
  ['API_KEY=planted-key python3 script.py', 'planted-key'],
  ['CREDENTIAL=planted-credential git status', 'planted-credential'],
  ['PASSWORD=planted-password rg needle .', 'planted-password'],
  ['AUTH=planted-auth ls', 'planted-auth'],
  ['env SECRET=planted-secret curl example.test', 'planted-secret'],
  ['curl -d password=planted-password https://example.test', 'planted-password'],
  ['rg /workspace/hunter2 /workspace/config.txt', 'hunter2'],
  ['grep /workspace/hunter2 /workspace/config.txt', 'hunter2'],
  ['python3 script.py /workspace/hunter2', 'hunter2'],
  ['curl hello\u00a0/workspace/hunter2', 'hunter2'],
  ['python3 -m pip', 'pip'],
  ['python3 -m venv', 'venv'],
  ['python3 -m pytest', 'pytest'],
  ['python3 -m unittest', 'unittest'],
  ['python3 -c "print(\'planted-secret\')"', 'planted-secret'],
  ['echo planted-pipe-secret | curl -d @- https://example.test', 'planted-pipe-secret'],
  ['cat <<EOF\nplanted-here-secret\nEOF', 'planted-here-secret'],
] as const;

async function expectNoLeak(command: string, secret: string): Promise<void> {
  const redacted = await redactCommand(command);
  expect(redacted ?? '').not.toContain(secret);
  expect(redacted ?? '').not.toContain('alice:');
  if (command.includes('\u00a0')) {
    expect(redacted).toBeNull();
  } else if (!command.includes('|') && !command.includes('<<')) {
    expect(redacted).not.toBeNull();
  }
}

it.each(plantedSecrets)('does not leak a planted secret in %s', expectNoLeak);

it('hides every flag, flag value and URL with fixed markers', async () => {
  expect(await redactCommand('curl -H "Authorization: Bearer secret" https://example.test'))
    .toBe('curl ••• ••• •••');
});

it('shows only reviewed subcommand words at the start of a command', async () => {
  expect(await redactCommand('git clone https://example.test/repo'))
    .toBe('git clone •••');
  expect(await redactCommand('git status --short'))
    .toBe('git status •••');
  expect(await redactCommand('git log --oneline'))
    .toBe('git log •••');
  expect(await redactCommand('npm install package'))
    .toBe('npm install •••');
  expect(await redactCommand('npm run build'))
    .toBe('npm run •••');
  expect(await redactCommand('npm test -- --watch'))
    .toBe('npm test ••• •••');
  expect(await redactCommand('pip install package'))
    .toBe('pip install •••');
  expect(await redactCommand('python3 -m pip --version'))
    .toBe('python3 ••• ••• •••');
});

it('hides every Python module name after a masked module flag', async () => {
  for (const moduleName of ['pip', 'venv', 'pytest', 'unittest']) {
    expect(await redactCommand(`python3 -m ${moduleName}`))
      .toBe('python3 ••• •••');
  }
});

it('masks words that only look like subcommands after an argument', async () => {
  expect(await redactCommand('git --token clone status'))
    .toBe('git ••• ••• •••');
  expect(await redactCommand('npm unknown install'))
    .toBe('npm ••• •••');
  expect(await redactCommand('python3 -m secret-module'))
    .toBe('python3 ••• •••');
});

it('shows a reviewed subcommand only for its own program', async () => {
  expect(await redactCommand('curl install'))
    .toBe('curl •••');
  expect(await redactCommand('git test'))
    .toBe('git •••');
  expect(await redactCommand('npm clone'))
    .toBe('npm •••');
  expect(await redactCommand('pip status'))
    .toBe('pip •••');
});

it('rejects DEL and every C1 control character within a known command', async () => {
  for (let characterCode = 0x7f; characterCode <= 0x9f; characterCode += 1) {
    const controlCharacter = String.fromCharCode(characterCode);
    expect(await redactCommand(`curl ${controlCharacter}secret`)).toBeNull();
    expect(await redactCommand(`curl secret${controlCharacter}`)).toBeNull();
  }
});

it('rejects commands over the length limit', async () => {
  const maximumLengthCommand = `curl ${'a'.repeat(16_379)}`;
  expect(maximumLengthCommand).toHaveLength(16_384);
  expect(await redactCommand(maximumLengthCommand)).toBe('curl •••');
  expect(await redactCommand(`${maximumLengthCommand}a`)).toBeNull();
});

it('keeps previews from commands with many arguments within the preview limit', async () => {
  const command = `echo ${'a '.repeat(5_000)}`;
  const preview = await redactCommand(command);
  expect(preview).not.toBeNull();
  expect(preview!.length).toBeLessThanOrEqual(16_384);
  expect(preview).toMatch(/^echo (?:••• )+…$/u);
});

it('hides every path, including paths beneath the workspace', async () => {
  expect(await redactCommand('cat /workspace/report.txt /workspace/notes/file.md'))
    .toBe('cat ••• •••');
  expect(await redactCommand('cat /workspace /workspace/../private /workspace/a=secret '
    + '/workspace/key:secret /tmp/report.txt'))
    .toBe('cat ••• ••• ••• ••• •••');
  expect(await redactCommand('git status /workspace/report.txt --token secret'))
    .toBe('git status ••• ••• •••');
});

it('splits words on ASCII spaces and tabs', async () => {
  expect(await redactCommand('git\tstatus \t/workspace/report.txt'))
    .toBe('git status •••');
});

it('hides workspace paths that could be flag values', async () => {
  expect(await redactCommand('curl --token /workspace/private.txt'))
    .toBe('curl ••• •••');
  expect(await redactCommand('git status --output /workspace/private.txt'))
    .toBe('git status ••• •••');
});

const unsupportedCommands = [
  'curl "unterminated secret',
  "curl 'unterminated secret",
  'echo (',
  'curl )',
  'echo foo(bar)',
  'echo secret | cat',
  'echo secret; cat',
  'echo secret & cat',
  'echo secret < input',
  'echo secret > output',
  'echo $secret',
  'echo `secret`',
  'echo secret\\ value',
  'echo secret\rvalue',
  'echo secret\nvalue',
  'echo secret\0value',
  'npm \u00a0install',
  'curl hello\u00a0/workspace/hunter2',
  'npm \uFEFFinstall',
  'git\vstatus',
  'git\fstatus',
  'git\u2028status',
  'git\u007fstatus',
  'curl -s #planted-secret',
  'curl --pass #planted-secret',
  'cat <<EOF\nsecret\nEOF',
  'mysql -phunter2',
  'PGPASSWORD=hunter2 psql',
  'docker login --password hunter2',
  'ssh-keygen -P hunter2',
];

async function expectNoCommandText(command: string): Promise<void> {
  expect(await redactCommand(command)).toBeNull();
}

it.each(unsupportedCommands)('shows no command text for unsupported command %s',
  expectNoCommandText);

it('masks every word after an unknown flag', async () => {
  expect(await redactCommand('curl -s --pass --token https://example.test'))
    .toBe('curl ••• ••• ••• •••');
});
