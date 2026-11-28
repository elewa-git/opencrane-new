import { setTimeout as delay } from 'node:timers/promises';

export type ProviderBindings = { rows?: Array<{ kind: string; position: number }> };

function isDefault(row: { kind: string }) {
  return row.kind === 'silo_default';
}

export async function waitForSeededDefault<Bindings extends ProviderBindings>(
  read: () => Promise<Bindings | undefined>,
) {
  // Give the background worker the same time as a fresh secondary service start.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const bindings = await read();
    const previous = bindings?.rows?.find(isDefault);
    if (bindings && previous) {
      return { bindings, previous };
    }
    await delay(100);
  }
  throw new Error('Provider setup default: timeout');
}
