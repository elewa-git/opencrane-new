import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('browser tab icon', () => {
  it('references the SVG icon before the ICO fallback', () => {
    const indexHtmlPath = resolve('apps/web/src/index.html');
    const indexHtml = readFileSync(indexHtmlPath, 'utf8');
    const svgIconPosition = indexHtml.indexOf('href="favicon.svg"');
    const icoIconPosition = indexHtml.indexOf('href="favicon.ico"');

    expect(svgIconPosition).toBeGreaterThanOrEqual(0);
    expect(icoIconPosition).toBeGreaterThan(svgIconPosition);
  });
});
