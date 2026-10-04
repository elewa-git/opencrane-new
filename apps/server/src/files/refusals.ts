import { z } from 'zod';

const fileRefusals = {
  unauthenticated: { statusCode: 401, message: 'Unauthenticated' },
  conversation_refused: { statusCode: 403, message: 'Conversation refused' },
  id_reused: { statusCode: 409, message: 'Id reused' },
  file_too_large: {
    statusCode: 413,
    message: 'File too large. Maximum size is 20 MiB.',
  },
  unsupported_file: { statusCode: 415, message: 'Unsupported or unsafe file content' },
  invalid_request: { statusCode: 400, message: 'Invalid request' },
  delivery_refused: { statusCode: 403, message: 'File delivery refused' },
} as const;

type FileRefusalKind = keyof typeof fileRefusals;

// These refusals belong to files; the shared HTTP guard is tracked in #121.
export class FileRefusal extends Error {
  readonly kind: FileRefusalKind;
  readonly statusCode: number;

  constructor(kind: FileRefusalKind, options?: ErrorOptions) {
    const refusal = fileRefusals[kind];
    super(refusal.message, options);
    this.name = 'FileRefusal';
    this.kind = kind;
    this.statusCode = refusal.statusCode;
  }
}

export class FileUnavailable extends Error {
  readonly kind: 'object_store' | 'event_store' | 'scanner';
  readonly statusCode = 503;

  constructor(kind: 'object_store' | 'event_store' | 'scanner', options?: ErrorOptions) {
    super('Dependency unavailable', options);
    this.name = 'FileUnavailable';
    this.kind = kind;
  }
}

export function isDependencyOutage(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  if ('code' in error) {
    switch (error.code) {
      case 'ECONNREFUSED':
      case 'ETIMEDOUT':
      case 'ServiceUnavailable':
      case 'SlowDown':
      case 'RequestTimeout':
        return true;
    }
  }
  return 'statusCode' in error && error.statusCode === 503;
}

export function parseFileInput<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.infer<Schema> {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const cause = { cause: error };
      throw new FileRefusal('invalid_request', cause);
    }
    throw error;
  }
}
