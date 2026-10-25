import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Keep fixed container accounts working. These names never identify a host operator.
// See docs/process/public-privacy.md for the complete exception list.
const containerHome = /^\/home\/(?:agent|codex|desktop|private|tool)(?=$|[^\w.-])/u;
const homePath = /(?<![\w.])\/home\/[^\s"'`<>),;]*/gu;
const ownerEmail = /@(?:[\w-]+\.)*elewa\.ke\b/iu;

function privateDetail(line) {
  if (ownerEmail.test(line)) {
    return 'owner-domain email';
  }
  for (const match of line.matchAll(homePath)) {
    if (!containerHome.test(match[0])) {
      return 'host home directory';
    }
  }
  return undefined;
}

function checkFile(file) {
  const bytes = readFileSync(file);
  if (bytes.includes(0)) {
    return false;
  }
  const content = bytes.toString('utf8');
  const lines = content.split('\n');
  let failed = false;
  for (let index = 0; index < lines.length; index++) {
    const reason = privateDetail(lines[index]);
    if (reason) {
      // Print the location only, so CI logs do not repeat the private value.
      console.error(`${file}:${index + 1}: ${reason}; use a documented placeholder`);
      failed = true;
    }
  }
  return failed;
}

const gitOptions = { maxBuffer: 16 * 1024 * 1024 };
const tracked = execFileSync('git', ['ls-files', '-z'], gitOptions);
const trackedNames = tracked.toString('utf8');
const files = trackedNames.split('\0');
let failed = false;
for (const file of files) {
  if (file && checkFile(file)) {
    failed = true;
  }
}
if (failed) {
  process.exitCode = 1;
} else {
  console.log('PASS: tracked text contains no private owner email or host home directory');
}
