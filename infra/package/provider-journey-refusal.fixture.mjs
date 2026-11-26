import { registerHooks } from 'node:module';

function fixtureModule(source) {
  return { format: 'module', source, shortCircuit: true };
}

function load(url, context, nextLoad) {
  if (url.endsWith('/infra/dev-stack/journey-entry.ts')) {
    return fixtureModule('export {};');
  }
  if (url.endsWith('/infra/dev-stack/config.ts')) {
    return fixtureModule(`export const directory = process.env.PROVIDER_JOURNEY_FIXTURE;
      export const root = process.cwd();`);
  }
  if (url.endsWith('/infra/dev-stack/packaged.ts')) {
    return fixtureModule(`export async function verifyPackageOwner() {
        return { namespace: 'fixture', release: 'fixture', context: 'fixture' };
      }
      export async function packageConnectionArgs() {
        return { args: ['--context=fixture'], environment: process.env };
      }`);
  }
  return nextLoad(url, context);
}

function resolve(specifier, context, nextResolve) {
  const driver = context.parentURL?.endsWith('/infra/package/provider-journey.test.mjs');
  if (driver && specifier === 'playwright') {
    const source = `async function launch() { throw new Error('Setup attempted to start Chromium'); }
      export const chromium = { launch };`;
    return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

const hooks = { load, resolve };
registerHooks(hooks);
