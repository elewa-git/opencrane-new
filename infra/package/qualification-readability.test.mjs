import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

async function declaresCallbacksBeforeCalls() {
  const text = await readFile(new URL('./qualification-signin.mjs', import.meta.url), 'utf8');
  const source = ts.createSourceFile('qualification-signin.mjs', text,
    ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const violations = [];
  function visit(node) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      for (const argument of node.arguments ?? []) {
        if (ts.isFunctionExpression(argument) || ts.isArrowFunction(argument)) {
          const position = source.getLineAndCharacterOfPosition(argument.getStart(source));
          violations.push(position.line + 1);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.deepEqual(violations, [], 'Declare callbacks before Promise and function calls');
}
test('the sign-in runner declares callbacks before their calls', declaresCallbacksBeforeCalls);
