import { lstatSync, readdirSync, readFileSync } from 'node:fs';

let rawInput = '';
for await (const chunk of process.stdin) {
  rawInput += chunk;
}
const input = JSON.parse(rawInput);
const hits = [];

function scanFile(path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    // Skip files which disappear or cannot be read during the scan.
    return;
  }
  for (const [kind, patterns] of Object.entries(input.patterns)) {
    function matches(pattern) {
      const decodedPattern = Buffer.from(pattern, 'base64');
      return bytes.includes(decodedPattern);
    }
    if (patterns.some(matches)) {
      hits.push({ path, kind });
      return;
    }
  }
}

function visit(path) {
  let information;
  try {
    information = lstatSync(path);
  } catch {
    // Skip paths which disappear during the scan.
    return;
  }
  if (information.isSymbolicLink()) return;
  if (information.isFile()) {
    scanFile(path);
    return;
  }
  if (!information.isDirectory()) return;
  let names;
  try {
    names = readdirSync(path);
  } catch {
    // Skip unreadable directories without following a different path.
    return;
  }
  for (const name of names) {
    visit(`${path}/${name}`);
  }
}

for (const path of input.paths) {
  visit(path);
}
process.stdout.write(JSON.stringify(hits) + '\n');
