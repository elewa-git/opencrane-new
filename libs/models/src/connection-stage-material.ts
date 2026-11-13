import type { connectionCustody, ConnectionStage } from './connection-custody.ts';
type Custody = Pick<ReturnType<typeof connectionCustody>, 'stage'>;

export async function stageMaterial(custody: Custody, stage: ConnectionStage, material: string) {
  try {
    const result = await custody.stage(stage, material);
    if ((result.status === 'staged' || result.status === 'recovered') && result.identity) {
      return result.identity;
    }
  } catch (error) {
    // Hide adapter errors because a transport error can contain the supplied material.
    throw new Error('Connection custody unavailable', { cause: error });
  }
  throw new Error('Connection custody unavailable');
}
