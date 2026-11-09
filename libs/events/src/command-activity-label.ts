export const commandActivityLabels = [
  'Ran a command', 'Listed files', 'Searched files', 'Read a PDF',
  'Ran a Python script', 'Drew a diagram', 'Installed a package',
] as const;

export type CommandActivityLabel = (typeof commandActivityLabels)[number];

const allowedLabels = new Set<string>(commandActivityLabels);

export function isCommandActivityLabel(value: unknown): value is CommandActivityLabel {
  return typeof value === 'string' && allowedLabels.has(value);
}
