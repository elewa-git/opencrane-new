import { appendFileSync } from 'node:fs';
import files from 'node:fs/promises';
import { registerHooks, syncBuiltinESMExports } from 'node:module';

function load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith('/infra/dev-stack/config.ts')) return result;
  if (process.env.JOURNEY_SAVED_MODE === '1') {
    const source = `
      import { appendFileSync } from 'node:fs';
      export const directory = process.env.HOME;
      export const root = process.cwd();
      export const base = {};
      export async function readEnv(name) {
        appendFileSync(process.env.JOURNEY_RECORD, name + ' read\\n');
        if (name === 'settings') return { DEV_REAL_PROVIDER: '1' };
        throw new Error('Journey setup reached');
      }
      export async function authEnv() { throw new Error('Journey auth reached'); }
    `;
    return { format: 'module', source, shortCircuit: true };
  }
  // Fail at evaluation before the real configuration module can read any data.
  const prefix = `
    import { appendFileSync as recordConfiguration } from 'node:fs';
    if (process.argv[2] !== 'up') {
      recordConfiguration(process.env.JOURNEY_RECORD, 'configuration read\\n');
      throw new Error('Configuration read before refusal');
    }
  `;
  return { ...result, source: prefix + result.source };
}
registerHooks({ load });
globalThis.fetch = async function refuseNetwork() {
  appendFileSync(process.env['JOURNEY_RECORD'], 'network attempted\n');
  throw new Error('Network is unavailable in refusal fixtures');
};

const originalStat = files.stat;
async function statFixture(path, ...args) {
  if (String(path).startsWith(process.env.HOME)) {
    appendFileSync(process.env.JOURNEY_RECORD, 'configuration read\n');
    throw new Error('Configuration read before refusal');
  }
  return originalStat(path, ...args);
}
files.stat = statFixture;
syncBuiltinESMExports();
