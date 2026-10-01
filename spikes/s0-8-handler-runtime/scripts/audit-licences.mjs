// Inventory the installed dependency tree, including development tools.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const rows = [];
for (const path of Object.keys(lock.packages).sort()) {
  if (!path || !existsSync(`${path}/package.json`)) continue;
  const pkg = JSON.parse(readFileSync(`${path}/package.json`, 'utf8'));
  let licence = pkg.license ?? 'UNKNOWN';
  if (pkg.name === 'unionfs' && readFileSync(`${path}/LICENSE`, 'utf8').includes('unencumbered software released into the public domain')) licence = 'Unlicense (LICENSE file)';
  rows.push(`${pkg.name}\t${pkg.version}\t${licence}\t${path}`);
}
writeFileSync('evidence/npm-licences.tsv', 'name\tversion\tlicence\tinstalled path\n' + rows.join('\n') + '\n');
console.log(`Recorded ${rows.length} installed packages. This inventory is not a linked-binary licence audit.`);
