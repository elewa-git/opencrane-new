import type { CommandActivityLabel } from '@opencrane/events/command-activity-label';

const directLabels = new Map<string, CommandActivityLabel>([
  ['ls', 'Listed files'],
  ['rg', 'Searched files'],
  ['grep', 'Searched files'],
  ['find', 'Searched files'],
  ['pdfinfo', 'Read a PDF'],
  ['pdftotext', 'Read a PDF'],
  ['dot', 'Drew a diagram'],
  ['mmdc', 'Drew a diagram'],
]);
const pythonPrograms = new Set(['python', 'python3']);
const packagePrograms = new Set(['npm', 'pip', 'pip3']);
const informationFlags = new Set(['--help', '--version', '-h', '-V']);

function hasInformationFlag(words: string[]): boolean {
  for (const word of words) {
    if (informationFlags.has(word)) return true;
  }
  return false;
}

// Read only a reviewed program name and simple command shape. Never copy command text
// into the label: arguments may contain private names, tokens or shell code.
export function commandActivityLabel(command: string): CommandActivityLabel {
  if (/[;&|`$<>\r\n]/u.test(command)) return 'Ran a command';

  const words = command.trim().split(/\s+/u);
  const program = words[0];
  const firstArgument = words[1];
  if (!program) return 'Ran a command';
  if (hasInformationFlag(words)) return 'Ran a command';

  const directLabel = directLabels.get(program);
  if (directLabel) return directLabel;
  if (pythonPrograms.has(program) && firstArgument
    && !firstArgument.startsWith('-') && firstArgument.endsWith('.py')) {
    return 'Ran a Python script';
  }
  if (packagePrograms.has(program) && firstArgument === 'install'
    && !words.includes('--dry-run')) {
    return 'Installed a package';
  }
  return 'Ran a command';
}
