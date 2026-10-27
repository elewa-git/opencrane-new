import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import ts from 'typescript';

// Follow emitted imports so type-only dependencies do not become runtime requirements.
function checkImports(sources) {
  const pending = ['infra/package/bootstrap.ts', 'infra/dev-stack/owner-bootstrap.ts'];
  const visited = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    const source = sources[file];
    assert.equal(typeof source, 'string');
    assert.equal(source, readFileSync(file, 'utf8'));
    const options = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext,
      verbatimModuleSyntax: true };
    const compiled = ts.transpileModule(source, { compilerOptions: options });
    const imports = ts.preProcessFile(compiled.outputText, true, true);
    for (const imported of imports.importedFiles) {
      if (imported.fileName.startsWith('.')) {
        pending.push(posix.join(dirname(file), imported.fileName));
      }
    }
  }
  console.log(`PASS ${visited.size} bootstrap modules match source and resolve relative imports`);
}

try {
  checkImports(JSON.parse(readFileSync(0, 'utf8')));
} catch {
  // Withhold source contents, fixture values and host paths from failure output.
  console.error('FAIL packaged bootstrap imports');
  process.exitCode = 1;
}
