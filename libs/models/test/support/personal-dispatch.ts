import type { fixture } from '../fixture.ts';
import { personalRequester } from './personal-requester.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;

export interface PersonalDispatchFixture {
  setup: Fixture;
  headers: Record<string, string>;
}

export async function personalPair<Context extends PersonalDispatchFixture>(
  context: Context, originalBody: string) {
  const { setup } = context;
  const bob = await personalRequester(setup, originalBody, context.headers);
  const dispatch = setup.dispatchOptions.credentialDispatch!;
  const readOriginal = dispatch.custody.readAccessMaterial;
  const reads: string[] = [];
  const readAccessMaterial: typeof readOriginal = async function readAccessMaterial(stage) {
    reads.push(stage.userId);
    if (stage.userId === 'bob') return 'bob-access';
    return readOriginal(stage, { reference: 'alice-secret', uid: 'alice-uid',
      resourceVersion: '1' });
  };
  dispatch.custody = { readAccessMaterial };
  return { ...context, bob, reads };
}
