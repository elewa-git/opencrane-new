import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const placeholder = '[REDACTED]';
const sensitiveName = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PAT/iu;
const slot = process.argv[2];
const source = process.argv[3];
const repository = process.argv[4];

function addSecret(secrets, value) {
  if (typeof value !== 'string') {
    throw new Error('Secret must be text');
  }
  if (value.length > 0) {
    secrets.add(value);
    secrets.add(value.trim());
  }
}

function readSecret(secrets, path) {
  const value = readFileSync(path, 'utf8');
  addSecret(secrets, value);
  // Cover individual private-key lines when a process prints only part of a key.
  for (const line of value.split('\n')) {
    if (line && !line.startsWith('-----')) {
      addSecret(secrets, line);
    }
  }
}

function readEnvironmentSecrets(secrets, path) {
  const content = readFileSync(path, 'utf8');
  for (const line of content.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator < 1) {
      throw new Error('Invalid environment file');
    }
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (sensitiveName.test(name) && !name.endsWith('_FILE')) {
      addSecret(secrets, value);
    }
    if (name === 'MODEL_KEY_FILE' || name === 'ZITADEL_KEY_FILE') {
      readSecret(secrets, value);
    }
    // Retain the password separately so bare database errors are covered too.
    if (/^[a-z][a-z\d+.-]*:\/\//iu.test(value)) {
      const url = new URL(value);
      addSecret(secrets, url.password);
      addSecret(secrets, decodeURIComponent(url.password));
    }
  }
}

function knownSecrets() {
  const secrets = new Set();
  for (const name of readdirSync(slot)) {
    const path = resolve(slot, name);
    if (name.endsWith('.env')) {
      readEnvironmentSecrets(secrets, path);
    } else if (name === 'passwords.json') {
      const passwords = JSON.parse(readFileSync(path, 'utf8'));
      for (const value of Object.values(passwords)) {
        addSecret(secrets, value);
      }
    } else if (/^zitadel-.*(?:password|client-secret)$/u.test(name) ||
        /\.(?:key|seed|pem)$/u.test(name) || name === 'model-stub-key') {
      readSecret(secrets, path);
    }
  }
  for (const name of ['MODEL_KEY_FILE', 'ZITADEL_KEY_FILE']) {
    if (process.env[name]) {
      readSecret(secrets, process.env[name]);
    }
  }
  const defaultZitadelKey = resolve(repository, '.keys/.zitadel-key');
  if (!process.env['ZITADEL_KEY_FILE'] && existsSync(defaultZitadelKey)) {
    readSecret(secrets, defaultZitadelKey);
  }
  secrets.delete('');
  return secrets;
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function longestFirst(left, right) {
  return right.length - left.length;
}

function redactKnownSecrets(content, secrets) {
  const values = Array.from(secrets);
  values.sort(longestFirst);
  if (values.length === 0) {
    return content;
  }
  const alternatives = values.map(escapePattern);
  const pattern = new RegExp(alternatives.join('|'), 'gu');
  return content.replace(pattern, placeholder);
}

function redactNamedValue(match, prefix, name) {
  if (sensitiveName.test(name) || name.toLowerCase() === 'authorization') {
    return `${prefix}${placeholder}`;
  }
  return match;
}

function redactPatterns(content) {
  // Withhold structured secret fields rather than risk retaining nested values.
  const structured = /["']([^"'\r\n]+)["']\s*:\s*[{[]/gu;
  for (const match of content.matchAll(structured)) {
    if (sensitiveName.test(match[1])) {
      throw new Error('Structured secret field');
    }
  }
  const namedValue = /((?:["']?)([\w.-]+)["']?\s*[:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\r\n,;}]+)/gu;
  let redacted = content.replace(namedValue, redactNamedValue);
  redacted = redacted.replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@]+:[^\s/@]*@/giu,
    `$1${placeholder}@`);
  redacted = redacted.replace(/\bBearer\s+[^\s"',;}]+/giu, `Bearer ${placeholder}`);
  redacted = redacted.replace(/\bAuthorization\s*:[^\r\n]*/giu,
    `Authorization: ${placeholder}`);
  return redacted;
}

function sanitise() {
  const secrets = knownSecrets();
  const content = readFileSync(source, 'utf8');
  let redacted = redactKnownSecrets(content, secrets);
  redacted = redactPatterns(redacted);
  if (!['failure.log', 'last-error.log'].includes(basename(source))) {
    const lines = redacted.split('\n');
    const endsWithNewline = lines.at(-1) === '';
    if (endsWithNewline) {
      lines.pop();
    }
    redacted = lines.slice(-100).join('\n');
    if (endsWithNewline) {
      redacted += '\n';
    }
  }
  // Emit nothing until every read and redaction has succeeded.
  process.stdout.write(redacted);
}

try {
  sanitise();
} catch {
  // Never print an exception: its message or path could contain a secret.
  process.exitCode = 1;
}
