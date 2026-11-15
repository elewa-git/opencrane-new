import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import tseslint from 'typescript-eslint';
import { baseCommit, readAtBase, mustNotRise } from './ci/baseline.mjs';

const listPath = 'scripts/lint-size-exceptions.json';
const suppressionsPath = 'eslint-suppressions.json';
const sizeRules = ['complexity', 'max-depth', 'max-lines', 'max-lines-per-function', 'max-params'];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parse(text) {
  const options = { comment: true, loc: true, ecmaFeatures: { jsx: true } };
  return tseslint.parser.parseForESLint(text, options).ast;
}

function trackedSources() {
  const options = { encoding: 'utf8' };
  const output = execFileSync('git', ['ls-files', '-z', '--', 'apps', 'libs', 'scripts'], options);
  const files = output.split('\0');
  function isSource(file) {
    return /\.[cm]?[jt]sx?$/.test(file);
  }
  return files.filter(isSource);
}

function disabledRules(comment) {
  const directive = /^\s*eslint-disable(?:-next-line|-line)?\s+([\s\S]*?)(?:\s+--|$)/;
  const match = directive.exec(comment.value);
  if (!match) return [];
  const names = match[1].split(/[\s,]+/);
  function isSizeRule(rule) {
    return sizeRules.includes(rule);
  }
  return names.filter(isSizeRule);
}

function configuredRules(comment) {
  if (!/^\s*eslint\s+/.test(comment.value)) return [];
  const rules = [];
  for (const rule of sizeRules) {
    const pattern = new RegExp(`(?:^|[\\s,'"])${rule}['"]?\\s*:`);
    if (pattern.test(comment.value)) rules.push(rule);
  }
  return rules;
}

function fileSizeCap(comment) {
  // Require the documented shape so duplicate options cannot hide the effective limit.
  const directive = '^\\s*eslint\\s+max-lines\\s*:\\s*\\[\\s*["\']error["\']\\s*,\\s*';
  const maximum = '\\{\\s*max\\s*:\\s*(\\d+)\\s*,\\s*';
  const skips = 'skipBlankLines\\s*:\\s*true\\s*,\\s*skipComments\\s*:\\s*true\\s*';
  const ending = '\\}\\s*\\]\\s*$';
  const pattern = new RegExp(directive + maximum + skips + ending);
  const match = pattern.exec(comment.value);
  if (!match) return undefined;
  return Number(match[1]);
}

function commentExceptions(file, comment) {
  const entries = [];
  for (const rule of disabledRules(comment)) {
    const entry = { file, rule };
    entries.push(entry);
  }
  for (const rule of configuredRules(comment)) {
    const entry = { file, rule, configured: true };
    if (rule === 'max-lines') entry.max = fileSizeCap(comment);
    entries.push(entry);
  }
  return entries;
}

function findExceptions() {
  const entries = [];
  for (const file of trackedSources()) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('eslint')) continue;
    const ast = parse(source);
    for (const comment of ast.comments) {
      entries.push(...commentExceptions(file, comment));
    }
  }
  return entries;
}

function sameException(first, second) {
  return first.file === second.file && first.rule === second.rule;
}

function findEntry(entries, expected) {
  function matches(entry) {
    return sameException(entry, expected);
  }
  return entries.find(matches);
}

function checkComments(listed, actual) {
  const problems = [];
  const seen = new Set();
  for (const entry of actual) {
    const key = `${entry.file}:${entry.rule}`;
    if (seen.has(key)) problems.push(`${key}: duplicate size exception comment`);
    seen.add(key);
    const allowed = findEntry(listed, entry);
    const label = `${entry.file}: ${entry.rule}`;
    if (!allowed) problems.push(`${label}: unlisted size exception`);
    else if (entry.configured && entry.rule !== 'max-lines') {
      problems.push(`${label}: only numbered max-lines overrides are allowed`);
    } else if (entry.rule === 'max-lines' && entry.max === undefined) {
      problems.push(`${label}: needs a numbered error limit with blank/comment lines skipped`);
    } else if (allowed.max !== undefined && (entry.max === undefined || entry.max > allowed.max)) {
      problems.push(`${label}: comment exceeds listed limit ${allowed.max}`);
    }
  }
  for (const entry of listed) {
    if (!findEntry(actual, entry)) {
      problems.push(`${entry.file}: ${entry.rule}: no matching comment`);
    }
  }
  return problems;
}

function countFileSizeRules(node) {
  if (!node || typeof node !== 'object') return 0;
  let count = 0;
  if (node.type === 'Property' && (node.key.value ?? node.key.name) === 'max-lines') count += 1;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) count += countFileSizeRules(child);
    } else if (value && typeof value === 'object') count += countFileSizeRules(value);
  }
  return count;
}

function suppressionTotals(suppressions) {
  const totals = {};
  for (const rules of Object.values(suppressions)) {
    for (const [rule, suppression] of Object.entries(rules)) {
      if (!Number.isSafeInteger(suppression.count) || suppression.count < 0) {
        throw new Error(`Invalid suppression count for ${rule}`);
      }
      totals[rule] = (totals[rule] ?? 0) + suppression.count;
    }
  }
  return totals;
}

function compareEntries(before, after) {
  const problems = [];
  for (const entry of after) {
    const previous = findEntry(before, entry);
    const label = `${entry.file}: ${entry.rule}`;
    if (!previous) problems.push(`${label}: new size exception`);
    else if (entry.max !== undefined) {
      const problem = mustNotRise(label, previous.max ?? 0, entry.max);
      if (problem) problems.push(problem);
    }
  }
  return problems;
}

function compareSuppressions(before, after) {
  const problems = [];
  const previous = suppressionTotals(before);
  const current = suppressionTotals(after);
  for (const [rule, count] of Object.entries(current)) {
    const problem = mustNotRise(`${rule} suppressions`, previous[rule] ?? 0, count);
    if (problem) problems.push(problem);
  }
  return problems;
}

function compareWithBase(entries, suppressions) {
  if (!baseCommit()) return [];
  const introducingPrettier = readAtBase('.prettierrc.json') === undefined &&
    existsSync('.prettierrc.json');
  if (introducingPrettier) return [];
  const problems = [];
  const previousEntries = readAtBase(listPath);
  const previousSuppressions = readAtBase(suppressionsPath);
  // Allow each ledger's first introduction; subsequent changes can only reduce debt.
  if (previousEntries !== undefined) {
    problems.push(...compareEntries(JSON.parse(previousEntries), entries));
  }
  if (previousSuppressions !== undefined) {
    problems.push(...compareSuppressions(JSON.parse(previousSuppressions), suppressions));
  }
  return problems;
}

function validateEntries(entries) {
  const seen = new Set();
  for (const entry of entries) {
    const key = `${entry.file}:${entry.rule}`;
    if (typeof entry.file !== 'string' || !sizeRules.includes(entry.rule) || seen.has(key)) {
      throw new Error(`Invalid or duplicate size exception: ${key}`);
    }
    if (entry.rule !== 'complexity' && (!Number.isSafeInteger(entry.max) || entry.max < 1)) {
      throw new Error(`Size exception needs a positive integer limit: ${key}`);
    }
    seen.add(key);
  }
}

function main() {
  const entries = readJson(listPath);
  validateEntries(entries);
  const actual = findExceptions();
  const problems = checkComments(entries, actual);
  const config = parse(readFileSync('eslint.config.mjs', 'utf8'));
  if (countFileSizeRules(config) > 2) {
    problems.push('eslint.config.mjs: max-lines may be set at most twice');
  }
  const suppressions = readJson(suppressionsPath);
  suppressionTotals(suppressions);
  problems.push(...compareWithBase(entries, suppressions));
  for (const problem of problems) console.error(problem);
  process.exitCode = problems.length ? 1 : 0;
}

main();
