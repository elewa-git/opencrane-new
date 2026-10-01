// Checks the shell's stylesheets as plain text. Angular's own test runner
// (jsdom) never loads the global stylesheet, so this file runs under the
// root vitest instead, where it can read the files from disk.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readCss(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

const globalCss = readCss('../src/styles.css');
const shellCss = readCss('../src/app/app.css');

const tokens = new Map<string, string>();
for (const [, name, value] of globalCss.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
  tokens.set(name!, value!.trim());
}

// WCAG relative luminance of a #rrggbb colour.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const c = parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

describe('theme tokens', () => {
  it('carry the primary palette, button mapping and radius from opencrane-preset.ts', () => {
    const palette = Object.fromEntries([...tokens].filter(([name]) => /^--oc-primary-\d+$/.test(name)));
    const shades = ['e9fbfe', 'cff6fb', '9eeaf4', '65d9e9', '2bc5d8', '0db5cc', '0a94a7', '0b7787', '105f6c', '124f59', '052f37'];
    const steps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
    expect(palette).toEqual(Object.fromEntries(steps.map((step, i) => [`--oc-primary-${step}`, `#${shades[i]}`])));
    expect(tokens.get('--oc-primary-contrast')).toBe('#16191a');
    expect(tokens.get('--oc-primary-hover')).toBe('var(--oc-primary-600)');
    expect(tokens.get('--oc-primary-active')).toBe('var(--oc-primary-700)');
    expect(tokens.get('--oc-radius-button')).toBe('7px');
  });

  it('never refer to a token that is not defined (such as PrimeNG ones, which are not installed)', () => {
    const used = [...(globalCss + shellCss).matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]!);
    expect([...new Set(used)].filter((name) => !tokens.has(name))).toEqual([]);
  });
});

describe('shell buttons', () => {
  it('use the preset radius and a hover colour that keeps the dark text readable', () => {
    expect(shellCss).toMatch(/\.button\s*\{[^}]*border-radius:\s*var\(--oc-radius-button\)/);
    expect(shellCss).toMatch(/\.button-primary:hover\s*\{[^}]*background:\s*var\(--oc-primary-hover\)/);

    const ink = luminance(tokens.get('--oc-primary-contrast')!);
    const hover = luminance(tokens.get('--oc-primary-600')!);
    expect((hover + 0.05) / (ink + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});
