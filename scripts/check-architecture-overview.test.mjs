import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';

const checker = fileURLToPath(new URL('./check-architecture-overview.mjs', import.meta.url));
const diagram = '```mermaid\nsequenceDiagram\nparticipant Browser\nparticipant Server\nBrowser->>Server: Send\n```\n';
const validPage = '# Overview\n\n`message.posted` starts in `apps/server/entry.ts`.\n' + diagram.repeat(3);
let repository;

function createRepository() {
  repository = mkdtempSync(join(tmpdir(), 'architecture-overview-'));
  execFileSync('git', ['init', '--quiet'], { cwd: repository });
  mkdirSync(join(repository, 'apps/server'), { recursive: true });
  mkdirSync(join(repository, 'docs/architecture'), { recursive: true });
  writeFileSync(join(repository, 'apps/server/entry.ts'), '');
  execFileSync('git', ['add', 'apps/server/entry.ts'], { cwd: repository });
}

function removeRepository() {
  rmSync(repository, { recursive: true, force: true });
}

function runCheck(markdown) {
  writeFileSync(join(repository, 'docs/architecture/overview.md'), markdown);
  return spawnSync(process.execPath, ['--experimental-strip-types', checker], {
    cwd: repository, encoding: 'utf8',
  });
}

beforeEach(createRepository);
afterEach(removeRepository);

function acceptsValidOverview() {
  const result = runCheck(validPage);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('check:overview — OK');
}

test('accepts three small diagrams with a registered event and tracked file', acceptsValidOverview);
