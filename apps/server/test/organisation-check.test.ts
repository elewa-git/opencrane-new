// Keep session checks consistent with sign-in and refuse unconfigured organisations.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const source = join(import.meta.dirname, '..', 'src');
// Claiming the first owner and accepting an invitation stay limited to the installation's own
// organisation, even in development. A person allowed in by name from elsewhere cannot join
// through an invitation.
const strictOnPurpose = ['members/bootstrap.ts', 'members/routes.ts'];
const apiRouteExceptions = ['members/bootstrap.ts'];
// Keep /healthz in server.ts public. It is outside /api and needs no session.
const routeMethods = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all', 'route',
]);

interface SourceChecks {
  calls: Set<string>;
  hasApiPath: boolean;
  registersRoute: boolean;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const children = await sourceFiles(path);
      files.push(...children);
    } else if (entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

function inspectSource(file: string, text: string): SourceChecks {
  const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const checks: SourceChecks = { calls: new Set(), hasApiPath: false, registersRoute: false };

  function visit(node: ts.Node): void {
    if (ts.isStringLiteralLike(node) && /^\/api(?:\/|$)/u.test(node.text)) {
      checks.hasApiPath = true;
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isIdentifier(expression)) {
        checks.calls.add(expression.text);
      } else if (ts.isPropertyAccessExpression(expression)) {
        checks.calls.add(expression.name.text);
        if (routeMethods.has(expression.name.text)) {
          checks.registersRoute = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(parsed);
  return checks;
}

async function comparesThroughSharedCheck(): Promise<void> {
  const strict = /orgId\s*[!=]==\s*\w*\.?expectedOrgId|expectedOrgId\s*[!=]==\s*\w*\.?orgId/u;
  const offenders: string[] = [];
  const files = await sourceFiles(source);
  for (const file of files) {
    const name = file.slice(source.length + 1);
    if (strictOnPurpose.includes(name)) continue;
    const text = await readFile(file, 'utf8');
    if (strict.test(text)) offenders.push(name);
  }
  expect(offenders).toEqual([]);
}

async function limitsSignInCheckToAuthRoutes(): Promise<void> {
  const offenders: string[] = [];
  const files = await sourceFiles(source);
  for (const file of files) {
    const name = file.slice(source.length + 1);
    if (name === 'auth/routes.ts') continue;
    const text = await readFile(file, 'utf8');
    const checks = inspectSource(file, text);
    if (checks.calls.has('isIdentityAllowed')) offenders.push(name);
  }
  expect(offenders).toEqual([]);
}

async function checksApiRouteFiles(): Promise<void> {
  const offenders: string[] = [];
  const files = await sourceFiles(source);
  for (const file of files) {
    const name = file.slice(source.length + 1);
    if (apiRouteExceptions.includes(name)) continue;
    const text = await readFile(file, 'utf8');
    const checks = inspectSource(file, text);
    if (checks.hasApiPath && checks.registersRoute && !checks.calls.has('isOrganisationSession')) {
      offenders.push(name);
    }
  }
  expect(offenders).toEqual([]);
}

it('compares the session organisation only through the shared check', comparesThroughSharedCheck);
it('uses isIdentityAllowed only in sign-in routes', limitsSignInCheckToAuthRoutes);
it('checks the organisation in every API route file except the first-owner claim', checksApiRouteFiles);
