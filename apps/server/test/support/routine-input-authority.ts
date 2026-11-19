import { expect } from 'vitest';

export async function expectRoutineInputAuthorityCycles(
  prepare: () => Promise<unknown>, arm: (action: () => Promise<void>) => void,
) {
  let checks = 0;
  function checked() {
    checks += 1;
    arm(checked);
    return Promise.resolve();
  }
  arm(checked);
  const receipt = await prepare();
  // Check before append, inside conditional append and after readback.
  expect(checks).toBe(3);
  checks = 0;
  expect(await prepare()).toEqual(receipt);
  // Renew authority once before returning an existing receipt.
  expect(checks).toBe(1);
}
