import { statSync } from 'node:fs';
import { conversationKeys } from '@opencrane/projections';

type Keys = ReturnType<typeof conversationKeys>;

/** Load the same stored keys as chat, bound to the worker's configured silo. */
export function loadRoutineCustody(silo: string, directory: string | undefined,
  wrappingKeyFile: string | undefined): Keys {
  try {
    if (!silo || !directory || !wrappingKeyFile || !statSync(directory).isDirectory()) {
      throw new Error('Missing routine custody');
    }
    const keys = conversationKeys(directory, wrappingKeyFile);
    function requireSilo(requestedSilo: string) {
      if (requestedSilo !== silo) throw new Error('Routine custody unavailable');
    }
    return {
      provision(requestedSilo, conversation) {
        requireSilo(requestedSilo);
        try {
          keys.provision(requestedSilo, conversation);
        } catch {
          throw new Error('Routine custody unavailable');
        }
      },
      encrypt(requestedSilo, conversation, text) {
        requireSilo(requestedSilo);
        try {
          return keys.encrypt(requestedSilo, conversation, text);
        } catch {
          throw new Error('Routine custody unavailable');
        }
      },
      decrypt(requestedSilo, conversation, encrypted) {
        requireSilo(requestedSilo);
        try {
          return keys.decrypt(requestedSilo, conversation, encrypted);
        } catch {
          throw new Error('Routine custody unavailable');
        }
      },
    };
  } catch {
    // Hide file names, key values and encrypted input from startup errors.
    throw new Error('Routine custody unavailable');
  }
}
