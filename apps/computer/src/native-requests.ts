import type { BridgeReport } from './report-journal.ts';

export function nativeRefusal(method: string): Pick<BridgeReport, 'requestKind' | 'outcome'> {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return { requestKind: 'shell', outcome: 'declined' };
    case 'item/fileChange/requestApproval':
      return { requestKind: 'file_change', outcome: 'declined' };
    case 'item/permissions/requestApproval':
      return { requestKind: 'permissions', outcome: 'unsupported' };
    case 'item/tool/requestUserInput':
      return { requestKind: 'user_input', outcome: 'unsupported' };
    default:
      return { requestKind: 'other', outcome: 'unsupported' };
  }
}

export function nativeRequests(send: (reply: Record<string, unknown>) => void,
  report: (message: Record<string, unknown>) => void, privateTurn = false) {
  // Retain ids for the lifetime of this Codex connection, including after a turn ends.
  const answered = new Set<unknown>();
  function handle(message: Record<string, unknown>) {
    const id = message['id'];
    const method = message['method'];
    if (id === undefined || typeof method !== 'string') return false;
    if (answered.has(id)) return true;
    answered.add(id);
    const refusal = nativeRefusal(method);
    if (!privateTurn && refusal.outcome === 'declined') {
      send({ id, result: { decision: 'decline' } });
    } else {
      let text = 'Native request is not supported';
      if (method === 'mcpServer/elicitation/request') text = 'Native consent is not supported';
      if (privateTurn) text = 'Not available in a private turn';
      send({ id, error: { code: -32601, message: text } });
    }
    report(message);
    return true;
  }
  return handle;
}
