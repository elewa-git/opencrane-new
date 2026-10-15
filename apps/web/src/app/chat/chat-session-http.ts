import { z } from 'zod';

export class ReadFailure extends Error {
  readonly status: number;
  constructor(status: number) {
    super('Chat request failed');
    this.status = status;
  }
}

export async function requestChat(path: string, body?: unknown): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const options: RequestInit = { signal: AbortSignal.timeout(15_000) };
    if (body) {
      options.method = 'POST';
      options.headers = { 'content-type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    const response = await fetch(path, options);
    // Retry a competing append with the same id so the saved command cannot be repeated.
    if (body && response.status === 409 && attempt < 2) continue;
    if (response.status !== 200) throw new ReadFailure(response.status);
    return response.json() as Promise<unknown>;
  }
}

export async function savedChatChange(
  command: { id: string; conversationId: string },
): Promise<boolean> {
  try {
    const path = `/api/conversations/${command.conversationId}/changes/${command.id}`;
    const result = await requestChat(path);
    const receipt = z.object({ status: z.literal('appended'),
      commandId: z.string() }).parse(result);
    return receipt.commandId === command.id;
  } catch (error) {
    if (error instanceof ReadFailure && error.status === 404) return false;
    throw error;
  }
}
