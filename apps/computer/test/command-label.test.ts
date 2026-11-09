import { expect, it } from 'vitest';
import { commandActivityLabel } from '../src/command-label.ts';

const knownCommands = [
  ['ls -la /workspace', 'Listed files'],
  ['rg invoice /workspace', 'Searched files'],
  ['pdftotext /workspace/report.pdf -', 'Read a PDF'],
  ['python3 /workspace/chart.py', 'Ran a Python script'],
  ['dot -Tpng diagram.dot', 'Drew a diagram'],
  ['npm install marked', 'Installed a package'],
] as const;

function expectReviewedLabel(command: string, label: string): void {
  expect(commandActivityLabel(command)).toBe(label);
}

it.each(knownCommands)('labels the reviewed command shape %s', expectReviewedLabel);

const unsafeCommands = [
  'curl -H "Authorization: Bearer secret" https://example.test',
  'python3 -c "print(secret)"',
  'ls /workspace && cat /workspace/secret',
  '/workspace/ls secret',
  'npm run private-task',
  'ls --help',
  'ls -l --help',
  'ls -l -h',
  'npm install --help',
  'npm install -h',
  'pip install --help',
  'python3 -Wignore.py -c "print(1)"',
  'npm install --dry-run',
];

function expectNeutralLabel(command: string): void {
  expect(commandActivityLabel(command)).toBe('Ran a command');
}

it.each(unsafeCommands)('uses a neutral label for unreviewed command %s', expectNeutralLabel);
