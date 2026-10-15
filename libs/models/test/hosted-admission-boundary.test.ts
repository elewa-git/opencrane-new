import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import * as models from '@opencrane/models';

function keepsWriterPrivate() {
  expect(models).not.toHaveProperty('writeHostedAdmission');
}
it('does not export the hosted admission writer to server callers', keepsWriterPrivate);

const serverRequire = createRequire(new URL('../../../apps/server/package.json', import.meta.url));
const privateImports = [
  '@opencrane/models/hosted-admission',
  '@opencrane/models/src/hosted-admission.ts',
];
function refusesPrivateImport(specifier: string) {
  function resolveFromServer() {
    return serverRequire.resolve(specifier);
  }
  expect(resolveFromServer).toThrow('Package subpath');
}
it.each(privateImports)('refuses the server package import %s', refusesPrivateImport);
