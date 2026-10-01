// Refuse to summarise an incomplete verification series as passing.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const series = {};
for (const [name, count] of [['final', 8], ['memory', 1], ['offline', 10]]) {
  series[name] = [1, 2, 3].map((n) => {
    const path = `evidence/verified-${name}-${n}.txt`;
    const text = readFileSync(path, 'utf8');
    if (!text.includes(`Tests  ${count} passed`) || !text.includes('Owned state directories after run: 0') || !text.includes('Completed ')) throw Error(`Incomplete evidence: ${path}`);
    return { path, assertionsOrTests: count, measurements: text.split('\n').filter((line) => /^\[(ordering|retry|budget-actor:memory)\]/.test(line)) };
  });
}
const hashes = {};
function visit(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) visit(path);
    else hashes[path] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
}
visit('src'); visit('tests'); visit('scripts');
for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts']) hashes[path] = createHash('sha256').update(readFileSync(path)).digest('hex');
writeFileSync('evidence/verification-summary.json', JSON.stringify({
  overall: 'PARTIAL',
  pgBoss: 'PARTIAL: one inherited full run; current PostgreSQL setup blocked',
  temporal: 'PASS: dev ordering/retry primitive only; other full conditions PARTIAL',
  hatchet: 'NOT_RUN', restate: 'EXCLUDED: BSL-1.1',
  series, mutationFindings: readFileSync('evidence/mutation-summary.txt', 'utf8').trim().split('\n'),
  finalSourceSha256: hashes,
}, null, 2) + '\n');
