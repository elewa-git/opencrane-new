import { expect, vi } from 'vitest';
import * as auth from '@opencrane/auth';
import * as models from '@opencrane/models';
import * as routes from '../../apps/server/src/files/routes.ts';
import * as scanner from '../../apps/server/src/files/scanner.ts';
import * as delivery from '../../apps/server/src/files/delivery.ts';
import * as scheduler from '../../apps/ops/src/routine-due.ts';
import * as tools from '../../libs/models/src/mcp-dispatch.ts';

export function recoveryEffectProbes() {
  const probes = [
    ['upload', vi.spyOn(routes, 'uploadFile')],
    ['scan', vi.spyOn(scanner, 'scanFile')],
    ['delivery', vi.spyOn(delivery, 'sendFile')],
    ['scheduler', vi.spyOn(scheduler, 'claimRoutineDue')],
    ['credential', vi.spyOn(auth, 'computerCredentials')],
    ['model', vi.spyOn(models, 'startDecision')],
    ['tool', vi.spyOn(tools, 'mcpDispatch')],
  ] as const;
  function refuseEffect(): never {
    throw new Error('Recovery effect probe reached');
  }
  for (const [, probe] of probes) {
    probe.mockImplementation(refuseEffect);
    function exercise() { Reflect.apply(probe, undefined, []); }
    expect(exercise).toThrow('Recovery effect probe reached');
    expect(probe).toHaveBeenCalledTimes(1);
    probe.mockClear();
  }
  function counts() {
    const result: Record<string, number> = {};
    for (const [name, probe] of probes) {
      result[name] = probe.mock.calls.length;
      expect(probe).not.toHaveBeenCalled();
    }
    return result;
  }
  return counts;
}
