import { expect, it } from 'vitest';
import { inspectFile } from '../src/files/types.ts';

it('accepts SVG as an image, including markup that must stay inert in the browser', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  await expect(inspectFile('drawing.svg', Buffer.from(svg))).resolves.toBe('image/svg+xml');
});

it('does not treat SVG markup renamed as text as a safe text file', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  await expect(inspectFile('drawing.txt', Buffer.from(svg))).rejects.toThrow();
});
