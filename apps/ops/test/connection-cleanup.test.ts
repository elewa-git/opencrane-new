import { expect, it } from 'vitest';
import { dispatcherHandlerNames } from '../src/dispatcher-handlers.ts';

function enablesConfiguredCustody() {
  expect(dispatcherHandlerNames({})).not.toContain('cleanup-connection');
  expect(dispatcherHandlerNames({ CONNECTION_CUSTODY_FILE: '  ' }))
    .not.toContain('cleanup-connection');
  expect(dispatcherHandlerNames({ CONNECTION_CUSTODY_FILE: '/private/custody.json' }))
    .toContain('cleanup-connection');
}
it('enables connection cleanup only with private custody configuration', enablesConfiguredCustody);
