// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Jente Rosseel
export async function readResponse(response: Response, maximumBytes = 32768): Promise<unknown> {
  if (!response.body) {
    throw new Error('Connection custody response invalid');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.length;
      if (size > maximumBytes) {
        throw new Error('Connection custody response too large');
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
  } finally {
    await reader.cancel();
  }
}

export function decodeToken(encoded: string) {
  const token = Buffer.from(encoded, 'base64');
  if (token.length === 0 || token.length > 8192 || token.toString('base64') !== encoded) {
    return undefined;
  }
  return token;
}
