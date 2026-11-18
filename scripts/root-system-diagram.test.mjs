import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const diagram = readme.match(/```mermaid\n([\s\S]*?)\n```/)?.[1];

function countDiagramBoxes(source) {
  return [...source.matchAll(/[a-z]+\["/gu)].length;
}

test('root system diagram names all eight processes and their responsibilities', () => {
  expect(diagram).toBeDefined();
  expect(countDiagramBoxes(diagram)).toBe(8);
  expect(diagram).toContain('apps/server<br/>web-facing server');
  expect(diagram).toContain('apps/server models process<br/>AI and tool decisions');
  expect(diagram).toContain('budget changes and child task starts');
  expect(diagram).toContain('background workers');
  expect(diagram).toContain('reads and saves data');
  expect(diagram).toContain('updates permissions');
  expect(diagram).toContain('starts and pauses computers');
  expect(diagram).not.toContain('Model provider or tool server');
});
