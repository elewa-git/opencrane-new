import { lintSource } from '@secretlint/core';
import { creator as recommendedRules } from '@secretlint/secretlint-rule-preset-recommend';

const hidden = '•••';
const knownPrograms = new Set([
  'cat', 'curl', 'dot', 'echo', 'env', 'find', 'git', 'grep', 'ls', 'mmdc', 'npm',
  'pdftotext', 'pdfinfo', 'pip', 'pip3', 'python', 'python3', 'rg', 'wget',
]);
const safeFlags = new Set([
  '-H', '-p', '-u', '--api-key', '--header', '--pass', '--password',
  '--secret', '--token', '--user',
]);
const assignmentName = /^[A-Za-z_][A-Za-z_0-9]*=/u;
const flagWithValue = /^(-{1,2}[A-Za-z][A-Za-z0-9-]*)=/u;
const unsafeShellSyntax = /[;&|<>$`\\\r\n\0]/u;
const ruleConfig = {
  rules: [{ id: '@secretlint/secretlint-rule-preset-recommend', rule: recommendedRules }],
};

function hasUnsupportedSyntax(command: string): boolean {
  return !command || command.length > 16_384 || unsafeShellSyntax.test(command);
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
    if (/\s/u.test(character)) {
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

function maskFlagWithEquals(word: string): string | null {
  const flag = flagWithValue.exec(word);
  if (!flag) return null;

  const name = flag[1];
  if (name && safeFlags.has(name)) return `${name}=${hidden}`;
  return hidden;
}

function maskArguments(words: string[]): string | null {
  const masked: string[] = [];
  let programFound = false;
  let maskNextValue = false;
  let maskRemainingWords = false;

  for (const word of words) {
    if (!programFound && assignmentName.test(word)) {
      masked.push(`${hidden}=${hidden}`);
      continue;
    }
    if (!programFound) {
      if (!knownPrograms.has(word)) return null;
      masked.push(word);
      programFound = true;
      continue;
    }
    if (maskRemainingWords) {
      masked.push(hidden);
      continue;
    }
    if (maskNextValue) {
      masked.push(hidden);
      maskNextValue = false;
      continue;
    }
    if (word.startsWith('#')) return null;
    if (assignmentName.test(word)) {
      masked.push(`${hidden}=${hidden}`);
      continue;
    }
    const equalsForm = maskFlagWithEquals(word);
    if (equalsForm !== null) {
      masked.push(equalsForm);
      continue;
    }
    if (safeFlags.has(word)) {
      masked.push(word);
      maskNextValue = true;
      continue;
    }
    if (word.startsWith('-')) {
      // Mask the rest because an unknown flag may be a switch or take a value.
      // Its next word could be another flag or private text that looks like one.
      masked.push(hidden);
      maskRemainingWords = true;
      continue;
    }
    masked.push(hidden);
  }

  if (!programFound) return null;
  return masked.join(' ');
}

function hasHighEntropyWord(command: string): boolean {
  const words = command.match(/[A-Za-z0-9_+/=-]{20,}/gu) ?? [];
  for (const word of words) {
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
    if (entropy >= 3.5) return true;
  }
  return false;
}

async function passesRuleScan(command: string): Promise<boolean> {
  const source = { content: command, contentType: 'text' as const,
    filePath: 'command.txt' };
  const options = { config: ruleConfig, noPhysicFilePath: true, maskSecrets: true };
  const result = await lintSource({ source, options });
  return result.messages.length === 0;
}

// Keep unsupported shell forms out of view. Only a fixed command shape survives
// argument masking, followed by the maintained rules and an entropy check.
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
