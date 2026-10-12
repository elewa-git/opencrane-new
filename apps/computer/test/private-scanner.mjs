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
  } catch (error) {
    // Allow a temporary file to disappear, but fail when its contents cannot be checked.
    if (error.code === 'ENOENT') return;
    throw error;
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
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
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
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    visit(`${path}/${name}`);
  }
}

for (const path of input.paths) {
  visit(path);
}
process.stdout.write(JSON.stringify(hits) + '\n');
