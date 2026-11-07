import { randomUUID } from 'node:crypto';
import type { GateIdentity } from './bridge-gate-authority.ts';
import { record } from './http.ts';
import { parseTools, type Turn } from './turn-frame.ts';
import type { PrivateThreadBinding, threadLoads } from './thread-loads.ts';

export type RecallOwner = Omit<PrivateThreadBinding, 'session' | 'tools' | 'grant' | 'checkTools'>;

function recallTools(input: Turn) {
  const tools = parseTools(input.tools);
  const server = tools[0];
  if (input.executionMode !== 'restricted' || input.sharingClass || input.rootId
    || input.taskKind !== 'chat_turn' || !input.requesterId
    || tools.length !== 1 || server?.serverId !== 'memory' || server.connectionId !== 'server') {
    throw new Error('Private recall refused');
  }
  requireRecallDefinitions(server);
  return { tools, serverKey: server.key, modes: server.modes };
}

function requireRecallDefinitions(server: ReturnType<typeof parseTools>[number]) {
  if (server.definitions.length < 1 || server.definitions.length > 4
    || Object.keys(server.modes).length !== server.definitions.length) {
    throw new Error('Private recall refused');
  }
  const names = ['recall', 'remember', 'correct', 'forget'];
  let previousPosition = -1;
  for (const encoded of server.definitions) {
    const definition = record(JSON.parse(encoded));
    const name = definition['name'];
    if (typeof name !== 'string') {
      throw new Error('Private recall refused');
    }
    const position = names.indexOf(name);
    if (position <= previousPosition || server.modes[name] !== 'allow') {
      throw new Error('Private recall refused');
    }
    previousPosition = position;
  }
}

export function privateRecall(input: Turn, owner: RecallOwner,
  session: PrivateThreadBinding['session'], identity: GateIdentity,
  loads: ReturnType<typeof threadLoads>) {
  const { tools, serverKey, modes } = recallTools(input);
  if (identity.assistant !== input.assistantId || identity.generation !== owner.generation) {
    throw new Error('Private recall refused');
  }
  const encoded = JSON.stringify(tools);
  const local = { ...owner, session };
  let receipt: Record<string, unknown> | undefined;
  let used = false;
  let ready = false;
  async function start() {
    const response = await loads.startPrivate(input, local);
    const thread = record(response['thread'])['id'];
    receipt = { type: 'recall_pending', loadId: randomUUID(), turnId: input.id,
      conversationId: input.conversationId, requesterId: input.requesterId,
      assistantId: input.assistantId, computerId: identity.computer, silo: identity.silo,
      threadId: thread, generation: owner.generation, inputGeneration: owner.inputGeneration,
      expiresAt: input.expiresAt };
    return { response, receipt };
  }
  async function load(value: Record<string, unknown>) {
    try {
      if (!receipt || used || value['type'] !== 'recall_load'
        || input.expiresAt <= Date.now() || Buffer.byteLength(JSON.stringify(value)) > 120 * 1024) {
        throw new Error();
      }
      used = true;
      const fields = Object.keys(value);
      if (fields.length !== Object.keys(receipt).length + 1) throw new Error();
      for (const [name, expected] of Object.entries(receipt)) {
        if (name !== 'type' && value[name] !== expected) throw new Error();
      }
      const approved = parseTools(value['tools']);
      if (JSON.stringify(approved) !== encoded) throw new Error();
      const grant = { turnId: input.id, conversation: input.conversationId,
        silo: identity.silo, computerId: identity.computer,
        requesterId: input.requesterId!, assistantId: input.assistantId,
        thread: String(receipt['threadId']), generation: owner.generation,
        inputGeneration: owner.inputGeneration, expires: input.expiresAt };
      // Check the local caller again after every loader wait. No registry crosses the wire.
      function checkTools(candidate: object, binding: { caller: string; grant: typeof grant }) {
        return candidate === approved && JSON.stringify(candidate) === encoded
          && binding.caller === owner.caller && binding.grant === grant
          && input.expiresAt > Date.now() && owner.authority.check(grant);
      }
      const binding = { ...local, tools: approved, grant, checkTools };
      await loads.loadPrivate(input, binding);
      ready = true;
      return { ...receipt, type: 'recall_loaded' };
    } catch {
      ready = false;
      session.close();
      throw new Error('Private recall refused');
    }
  }
  function permitsItem(item: Record<string, unknown>) {
    const name = item['tool'];
    return ready && typeof name === 'string' && modes[name] === 'allow' && item['type'] === 'mcpToolCall'
      && item['server'] === serverKey;
  }
  return { start, load, permitsItem, get ready() { return ready; } };
}
