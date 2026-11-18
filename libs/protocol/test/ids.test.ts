import { expect, it } from 'vitest';
import { recordIdPattern, recordIdSchema } from '../src/index.ts';
import { recordIdPattern as eventPattern, recordIdSchema as eventSchema }
  from '@opencrane/events';

function exposesSharedIdChecks() {
  expect(recordIdPattern).toBe(eventPattern);
  expect(recordIdSchema).toBe(eventSchema);
}

it('exposes the shared ID checks to browser callers', exposesSharedIdChecks);
