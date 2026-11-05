import { expect, it } from 'vitest';
import { inspectFile } from '../src/files/types.ts';

async function acceptsSvgAsImage() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  await expect(inspectFile('drawing.svg', Buffer.from(svg))).resolves.toBe('image/svg+xml');
}

it('accepts SVG as an image, including markup that must stay inert in the browser',
  acceptsSvgAsImage);

async function acceptsSvgWithXmlDeclaration() {
  const svg = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
  await expect(inspectFile('drawing.svg', Buffer.from(svg))).resolves.toBe('image/svg+xml');
}

it('accepts an SVG that starts with an XML declaration', acceptsSvgWithXmlDeclaration);

async function refusesSvgRenamedAsText() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  await expect(inspectFile('drawing.txt', Buffer.from(svg))).rejects.toThrow();
}

it('does not treat SVG markup renamed as text as a safe text file', refusesSvgRenamedAsText);

async function refusesUnsafeSvgRoots() {
  const withEntities = '<!DOCTYPE svg [<!ENTITY hidden "private">]><svg>&hidden;</svg>';
  const wrongRoot = '<html><svg></svg></html>';
  await expect(inspectFile('drawing.svg', Buffer.from(withEntities))).rejects.toThrow();
  await expect(inspectFile('drawing.svg', Buffer.from(wrongRoot))).rejects.toThrow();
}

it('refuses SVG with document type declarations or a different root', refusesUnsafeSvgRoots);
