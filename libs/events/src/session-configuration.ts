export type SessionConfigurationInput = {
  conversation: {
    contextKind?: 'shared_child' | undefined;
    routinePreparation?: unknown;
    payingGroupId?: string | undefined;
  };
  assistantKind?: string | undefined;
  assistantPayingGroupId?: string | undefined;
  sharingClass?: 'shared_only' | undefined;
  requestedMode?: unknown;
  memoryEnabled: boolean;
};

export type SessionConfiguration = {
  kind: 'personal' | 'team_private' | 'shared_child' | 'routine';
  payer: 'installation_default' | 'assistant_group' | 'root_allowance';
  payerMatchesAssistant: boolean;
  assistantPayerRequired: boolean;
  executionMode: 'restricted' | 'memory_free';
  process: 'persistent_thread' | 'fresh_isolated';
  context: 'thread' | 'own_exchanges' | 'shared_exchanges' | 'routine_input';
  tools: 'none' | 'memory_only' | 'reviewed_mcp';
  credentials: { personal: boolean; company: 'never' | 'routine_ask' };
  memory: 'none' | 'personal';
  uploads: boolean;
  attachments: boolean;
  localTools: boolean;
  sharingClass: 'shared_only' | undefined;
};

export function sessionConfiguration(input: SessionConfigurationInput): SessionConfiguration {
  const kind = sessionKind(input);
  const executionMode = sessionExecutionMode(input, kind);
  const restricted = executionMode === 'restricted';
  const personal = input.assistantKind === 'personal' && kind === 'personal';
  const tools = sessionTools(kind, personal, restricted);
  const credentials: SessionConfiguration['credentials'] = {
    personal: personal && !restricted,
    company: kind === 'routine' ? 'routine_ask' : 'never',
  };
  return {
    kind,
    payer: sessionPayer(kind),
    assistantPayerRequired: input.assistantKind === 'team',
    payerMatchesAssistant: Boolean(input.assistantPayingGroupId)
      && input.conversation.payingGroupId === input.assistantPayingGroupId,
    executionMode,
    process: restricted ? 'fresh_isolated' : 'persistent_thread',
    context: sessionContext(kind, restricted),
    tools,
    credentials,
    memory: personal && restricted ? 'personal' : 'none',
    uploads: input.assistantKind !== 'team',
    attachments: !restricted,
    localTools: !restricted,
    sharingClass: kind === 'shared_child' ? 'shared_only' : undefined,
  };
}

function sessionKind(input: SessionConfigurationInput): SessionConfiguration['kind'] {
  if (input.conversation.routinePreparation !== undefined) return 'routine';
  if (input.conversation.contextKind === 'shared_child' || input.sharingClass === 'shared_only') {
    return 'shared_child';
  }
  if (input.assistantKind === 'team') return 'team_private';
  return 'personal';
}

function sessionExecutionMode(input: SessionConfigurationInput,
  kind: SessionConfiguration['kind']): SessionConfiguration['executionMode'] {
  if (input.requestedMode === 'memory_free') return 'memory_free';
  if (kind !== 'personal' || input.memoryEnabled) return 'restricted';
  return 'memory_free';
}

function sessionPayer(kind: SessionConfiguration['kind']): SessionConfiguration['payer'] {
  if (kind === 'routine' || kind === 'shared_child') return 'root_allowance';
  if (kind === 'team_private') return 'assistant_group';
  return 'installation_default';
}

function sessionContext(kind: SessionConfiguration['kind'],
  restricted: boolean): SessionConfiguration['context'] {
  if (kind === 'routine') return 'routine_input';
  if (kind === 'shared_child') return 'shared_exchanges';
  if (restricted) return 'own_exchanges';
  return 'thread';
}

function sessionTools(kind: SessionConfiguration['kind'],
  personal: boolean, restricted: boolean): SessionConfiguration['tools'] {
  if (kind === 'routine') return 'reviewed_mcp';
  if (!personal) return 'none';
  if (restricted) return 'memory_only';
  return 'reviewed_mcp';
}
