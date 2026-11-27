import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { sha256Hex } from '@opencrane/events/digest';

export function briefTemplate(name: string) {
  const path = new URL(`./prompts/${name}.md`, import.meta.url);
  const template = readFileSync(path, 'utf8');
  return template.trim();
}

export const defaultSoulFile = new URL('./prompts/soul.md', import.meta.url).pathname;

export function renderSoul(persona?: string) {
  const soul = briefTemplate('soul');
  if (!persona) return soul;
  const identity = briefTemplate('persona');
  return `${soul}\n\n${identity}\n\n${persona}\n`;
}

export function writeSessionSoul(persona: string | undefined, directory: string) {
  const soul = renderSoul(persona);
  const digest = sha256Hex(soul);
  const path = `${directory}/${digest}.md`;
  // Keep approved identity outside the writable workspace and persistent disk.
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path, soul, { mode: 0o600 });
  return path;
}
