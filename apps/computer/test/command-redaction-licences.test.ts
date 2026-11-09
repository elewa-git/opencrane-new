import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

function readJson(path: string): unknown {
  const text = readFileSync(new URL(path, import.meta.url), 'utf8');
  return JSON.parse(text) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

const lock = readJson('../../../package-lock.json');
const approvedList = readJson('../../../infra/package/osi-licences.json');
if (!Array.isArray(approvedList) || !approvedList.every(isString)) {
  throw new Error('Invalid OSI licence list');
}
const approved = new Set(approvedList);

function checkDependency(name: string, visited: Set<string>): void {
  if (visited.has(name)) return;
  visited.add(name);
  if (!isRecord(lock) || !isRecord(lock['packages'])) {
    throw new Error('Invalid package lock');
  }
  const entry = lock['packages'][`node_modules/${name}`];
  expect(isRecord(entry), `${name} must be in the lockfile`).toBe(true);
  if (!isRecord(entry)) return;
  const licence = entry['license'];
  expect(isString(licence) && approved.has(licence),
    `${name} must have an OSI licence`).toBe(true);
  const dependencies = entry['dependencies'];
  if (dependencies !== undefined && !isRecord(dependencies)) {
    throw new Error(`Invalid dependencies for ${name}`);
  }
  for (const dependency of Object.keys(dependencies ?? {})) {
    checkDependency(dependency, visited);
  }
}

it('checks the redactor and its installed rule set against the OSI list', () => {
  const visited = new Set<string>();
  checkDependency('@secretlint/core', visited);
  checkDependency('@secretlint/secretlint-rule-preset-recommend', visited);
  expect(visited.size).toBeGreaterThan(2);
});
