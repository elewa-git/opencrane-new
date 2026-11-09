import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

function readJson(path: string): unknown {
  const text = readFileSync(path, 'utf8');
  return JSON.parse(text) as unknown;
}

function property(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || !(key in value)) return undefined;
  return Reflect.get(value, key) as unknown;
}

function workspacePackageNames(): string[] {
  const names: string[] = [];

  for (const folder of ['apps', 'libs']) {
    const folderPath = join(repositoryRoot, folder);
    const entries = readdirSync(folderPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const packagePath = join(folderPath, entry.name, 'package.json');
      const packageJson = readJson(packagePath);
      const name = property(packageJson, 'name');
      if (typeof name === 'string' && name.startsWith('@opencrane/')) names.push(name);
    }
  }

  return names.sort();
}

function excludesEveryWorkspacePackage(): void {
  const configPath = join(repositoryRoot, 'apps/web/angular.json');
  const config = readJson(configPath);
  const projects = property(config, 'projects');
  const web = property(projects, 'web');
  const architect = property(web, 'architect');
  const serve = property(architect, 'serve');
  const options = property(serve, 'options');
  const prebundle = property(options, 'prebundle');
  const excluded = property(prebundle, 'exclude');

  expect(excluded).toEqual(workspacePackageNames());
}

it('keeps every workspace package out of the web dev server pre-bundle',
  excludesEveryWorkspacePackage);
