import { lintSource } from '@secretlint/core';
import { creator as recommendedRules } from '@secretlint/secretlint-rule-preset-recommend';

const hidden = '•••';
const knownPrograms = new Set([
  'cat', 'curl', 'dot', 'echo', 'env', 'find', 'git', 'grep', 'ls', 'mmdc', 'npm',
  'pdftotext', 'pdfinfo', 'pip', 'pip3', 'python', 'python3', 'rg', 'wget',
]);
const reviewedSubcommands = new Map<string, readonly (readonly string[])[]>([
  ['git', [['clone'], ['status'], ['log']]],
  ['npm', [['install'], ['run'], ['test']]],
  ['pip', [['install']]],
  ['pip3', [['install']]],
]);
const assignmentName = /^[A-Za-z_][A-Za-z_0-9]*=/u;
const unsafeShellSyntax = /[;&|<>$`\\]/u;
const whitespace = /\s/u;
const ruleConfig = {
  rules: [{ id: '@secretlint/secretlint-rule-preset-recommend', rule: recommendedRules }],
};

function hasUnsupportedSyntax(command: string): boolean {
  if (!command || command.length > 16_384 || unsafeShellSyntax.test(command)) return true;

  // Accept only spaces and tabs as separators. Other whitespace and control
  // characters may form a single private shell argument or change its meaning.
  for (const character of command) {
    if (character === ' ' || character === '\t') continue;
    if (whitespace.test(character)) return true;
    const characterCode = character.charCodeAt(0);
    if (characterCode < 0x20) return true;
    if (characterCode >= 0x7f && characterCode <= 0x9f) return true;
  }
  return false;
}

function completeWords(
  words: string[],
  lastWord: string,
  lastWordStarted: boolean,
  quote: 'single' | 'double' | null,
): string[] | null {
  if (quote !== null) return null;
  if (lastWordStarted) words.push(lastWord);
  if (words.length === 0) return null;
  return words;
}

function parseSimpleWords(command: string): string[] | null {
  if (hasUnsupportedSyntax(command)) return null;

  const words: string[] = [];
  let word = '';
  let quote: 'single' | 'double' | null = null;
  let started = false;

  for (const character of command) {
    if (quote === 'single' && character === "'") {
      quote = null;
      continue;
    }
    if (quote === 'double' && character === '"') {
      quote = null;
      continue;
    }
    if (quote !== null) {
      word += character;
      continue;
    }
    if (character === '(' || character === ')') return null;
    if (character === "'") {
      quote = 'single';
      started = true;
      continue;
    }
    if (character === '"') {
      quote = 'double';
      started = true;
      continue;
    }
    if (character === ' ' || character === '\t') {
      if (started) words.push(word);
      word = '';
      started = false;
      continue;
    }
    word += character;
    started = true;
  }

  return completeWords(words, word, started, quote);
}

function matchingSubcommandLength(program: string, argumentsAfterProgram: string[]): number {
  const allowedSequences = reviewedSubcommands.get(program) ?? [];
  let longestMatch = 0;

  for (const sequence of allowedSequences) {
    if (sequence.length <= longestMatch) continue;

    let matches = true;
    for (let index = 0; index < sequence.length; index += 1) {
      if (argumentsAfterProgram[index] !== sequence[index]) {
        matches = false;
        break;
      }
    }
    if (matches) longestMatch = sequence.length;
  }

  return longestMatch;
}

function maskArguments(words: string[]): string | null {
  let programIndex = 0;
  while (programIndex < words.length) {
    const word = words[programIndex];
    if (!word || !assignmentName.test(word)) break;
    programIndex += 1;
  }

  const program = words[programIndex];
  if (!program || !knownPrograms.has(program)) return null;

  const argumentsAfterProgram = words.slice(programIndex + 1);
  const subcommandLength = matchingSubcommandLength(program, argumentsAfterProgram);
  const masked: string[] = [];
  for (let index = 0; index < programIndex; index += 1) {
    masked.push(hidden);
  }
  masked.push(program);

  for (const [index, word] of argumentsAfterProgram.entries()) {
    if (word.startsWith('#')) return null;

    if (index < subcommandLength) {
      masked.push(word);
      continue;
    }

    masked.push(hidden);
  }

  return masked.join(' ');
}

function hasHighEntropyWord(command: string): boolean {
  const visibleWords = command.split(' ');
  for (const visibleWord of visibleWords) {
    const candidates = visibleWord.match(/[A-Za-z0-9_+/=-]{20,}/gu) ?? [];
    for (const candidate of candidates) {
      if (hasHighEntropy(candidate)) return true;
    }
  }
  return false;
}

function hasHighEntropy(word: string): boolean {
  const counts = new Map<string, number>();
  for (const character of word) {
    const count = counts.get(character) ?? 0;
    counts.set(character, count + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const frequency = count / word.length;
    entropy -= frequency * Math.log2(frequency);
  }
  return entropy >= 3.5;
}

async function passesRuleScan(command: string): Promise<boolean> {
  const source = { content: command, contentType: 'text' as const,
    filePath: 'command.txt' };
  const options = { config: ruleConfig, noPhysicFilePath: true, maskSecrets: true };
  const result = await lintSource({ source, options });
  return result.messages.length === 0;
}

// Show only reviewed command words. Scan that small result once more before
// it can leave the computer.
export async function redactCommand(command: string): Promise<string | null> {
  const words = parseSimpleWords(command);
  if (!words) return null;
  const masked = maskArguments(words);
  if (!masked) return null;
  try {
    if (!await passesRuleScan(masked)) return null;
  } catch {
    return null;
  }
  if (hasHighEntropyWord(masked)) return null;
  return masked;
}
