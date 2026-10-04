const fileRefusals = {
  unauthenticated: { statusCode: 401, message: 'Unauthenticated' },
  conversation_refused: { statusCode: 403, message: 'Conversation refused' },
  id_reused: { statusCode: 409, message: 'Id reused' },
  file_too_large: {
    statusCode: 413,
    message: 'File too large. Maximum size is 20 MiB.',
  },
  unsupported_file: { statusCode: 415, message: 'Unsupported or unsafe file content' },
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
