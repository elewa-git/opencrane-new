// Protocol fixtures for visual qualification only; never imported into the product.
export async function chatFixture(page, scenario = 'live') {
  let stopConflict = false;
  let socketReady = false;
  let rows = [], socket, offline = ['queued', 'rail-offline'].includes(scenario);
  const add = (type, data) => {
    const row = { id: `event-${rows.length + 1}`, position: rows.length + 1, type, data, time: type === 'agent.turn_completed' ? '2026-10-02T10:42:48Z' : '2026-10-02T10:42:00Z' };
    rows.push(row);
    socket?.send(JSON.stringify({ version: 1, type: 'event', topic: 'conversation', conversationId: 'chat', generation: 1, position: row.position, row }));
    return row;
  };
  const teamSession = scenario.startsWith('private-team-');
  const creation = { conversationId: 'chat', createdBy: 'me', assistantId: 'assistant',
    ...(teamSession ? { payingGroupId: 'opaque-sales' } : {}) };
  add('conversation.created', creation);
  if (scenario === 'private-team-recovering') {
    const earlier = add('message.posted', { text: 'Earlier question', authorId: 'me' });
    const earlierStart = add('agent.turn_started', { turnId: earlier.id, executionMode: 'restricted' });
    const earlierEnd = add('agent.turn_completed', { turnId: earlier.id });
    const current = add('message.posted', { text: 'Draft the reply to Supplier B.', authorId: 'me' });
    const currentStart = add('agent.turn_started', { turnId: current.id, executionMode: 'restricted' });
    const outputLost = add('agent.output_lost', { turnId: current.id });
    const failed = add('agent.turn_failed', { turnId: current.id, reason: 'computer_lost' });
    earlier.time = '2026-10-02T10:00:00Z';
    earlierStart.time = '2026-10-02T10:00:01Z';
    earlierEnd.time = '2026-10-02T10:01:00Z';
    current.time = '2026-10-02T10:02:00Z';
    currentStart.time = '2026-10-02T10:02:01Z';
    outputLost.time = '2026-10-02T10:03:00Z';
    failed.time = '2026-10-02T10:03:00Z';
  } else if (scenario === 'private-team-recovered') {
    const human = add('message.posted', { text: 'Draft the reply to Supplier B.', authorId: 'me' });
    const started = add('agent.turn_started', { turnId: human.id, executionMode: 'restricted' });
    const lost = add('agent.output_lost', { turnId: human.id });
    const failed = add('agent.turn_failed', { turnId: human.id, reason: 'computer_lost' });
    human.time = '2026-10-02T10:02:00Z';
    started.time = '2026-10-02T10:02:01Z';
    lost.time = '2026-10-02T10:03:00Z';
    failed.time = '2026-10-02T10:03:00Z';
  } else if (!['draft', 'empty-selected', 'attach', 'no-agent', 'queued', 'private-team-draft'].includes(scenario)) {
    const human = add('message.posted', { text: scenario === 'long-title' ? 'M'.repeat(500) : 'Pull the Q3 board pack together. Focus on the revenue story and flag anything that needs a decision.', authorId: 'me' });
    add('agent.turn_started', { turnId: human.id });
    if (scenario === 'workspace-evidence') {
      add('agent.command_ran', { turnId: human.id, exitCode: 1, commandDigest: 'a'.repeat(64) });
      add('agent.file_changed', { turnId: human.id, path: 'quarterly-board-pack.xlsx', changeType: 'created' });
      add('decision.recorded', { turnId: human.id, reason: 'budget_exhausted' });
      add('agent.turn_failed', { turnId: human.id });
      add('file.uploaded', { conversationId: 'chat', fileId: 'screen', uploadedBy: 'another-member',
        name: 'quarterly-screen-capture.png', size: 421888, mime: 'image/png',
        screenshot: { computerId: 'computer', generation: 1, capturedAt: '2026-10-02T10:42:00Z',
          width: 1440, height: 900 } });
    } else if (scenario !== 'folding') {
      add('agent.command_ran', { turnId: human.id, exitCode: scenario === 'tools' ? 1 : 0, commandDigest: 'a'.repeat(64) });
      const text = scenario === 'a2ui' ? 'Here is the overview.\n\n```a2ui\n{"type":"summary"}\n```'
        : 'I’ve pulled the numbers from Finance and the notes from the last review.\n\n**Revenue is up 18% quarter on quarter**, with the strongest growth in the enterprise segment. The main risk is the timing of two renewals. [1]\n\nThe draft is ready for your review. I’ve highlighted the assumptions that still need a decision.';
      add('agent.message_delta', { turnId: human.id, messageId: 'reply', text });
      if (scenario !== 'streaming') {
        if (['live', 'assets', 'panel', 'compact'].includes(scenario)) add('agent.file_changed', { turnId: human.id, path: 'board-pack-q3.pdf' });
        add('agent.turn_completed', { turnId: human.id });
      }
      if (scenario === 'tools') {
        add('agent.command_ran', { turnId: human.id, exitCode: 0, commandDigest: 'b'.repeat(64) });
      }
      if (scenario === 'closed') add('conversation.closed', {});
    }
  }
  const conversations = ['chat', 'research', 'done', 'closed', 'failed'].map((id, index) => ({ conversationId: id, assistantId: 'assistant', assistantKind: teamSession ? 'team' : 'personal', ...(teamSession ? { payingGroupId: 'opaque-sales' } : {}), createdBy: 'me', mode: 'agent_session', createdAt: '2026-10-02T10:40:00Z',
    title: ['board-pack-q3', 'county-rollout', 'weekly-review', 'last-quarter', 'finance-export'][index], status: ['open', 'working', 'done', 'closed', 'failed'][index] }));
  const commands = [];
  await page.route('**/auth/me', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ authenticated: true, user: { name: 'Alex Morgan' } }) }));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const fulfil = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.includes('/changes/')) {
      const commandId = url.pathname.split('/').at(-1);
      function hasCommand(row) {
        return row.id === commandId;
      }
      const recorded = rows.some(hasCommand);
      if (recorded) return fulfil({ status: 'appended', commandId });
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    }
    if (url.pathname.endsWith('/approvals')) return fulfil({ cards: [], csrf: 'fixture' });
    if (url.pathname === '/api/chat' && offline && scenario === 'rail-offline') return route.abort('connectionfailed');
    if (url.pathname === '/api/chat' && scenario === 'rail-loading') return;
    if (url.pathname === '/api/chat') return fulfil({ memberId: 'me', displayName: 'Taylor Reed', assistantId: scenario === 'no-agent' ? null : 'assistant', memoryAdmission: { state: 'disabled', failing: ['The private memory checks have not all passed.'] } });
    if (url.pathname.endsWith('/messages') && scenario.startsWith('read-')) {
      const status = Number(scenario.slice('read-'.length));
      return route.fulfill({ status, contentType: 'application/json', body: '{}' });
    }
    if (url.pathname.endsWith('/files/view')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    if (request.method() === 'POST') {
      const command = request.postDataJSON(); commands.push(command);
      if (offline) return route.abort('connectionfailed');
      if (url.pathname === '/api/conversations') { conversations.unshift({ ...conversations[0], conversationId: command.conversationId }); return fulfil({ status: 'appended', sequence: 1 }); }
      if (command.stopTurnId && stopConflict) { stopConflict = false; return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ status: 'conflict' }) }); }
      if (command.stopTurnId) { add('agent.turn_stop_requested', { turnId: command.stopTurnId }); return fulfil({ status: 'appended', sequence: rows.length }); }
      if (!rows.some(row => row.id === command.id)) {
        const row = add('message.posted', { text: command.text, authorId: 'me' }); row.id = command.id;
      }
      return fulfil({ status: 'appended', sequence: rows.length });
    }
    if (url.pathname === '/api/conversations') return fulfil({ rows: ['draft', 'attach', 'no-agent', 'queued'].includes(scenario) && conversations.length === 5 ? [] : conversations });
    const computerState = fixtureComputerState(scenario);
    const computerRecovered = scenario === 'private-team-recovered';
    const computerLostAt = ['private-team-recovering', 'private-team-recovered'].includes(scenario)
      ? '2026-10-02T10:03:00.000Z' : undefined;
    return fulfil({ rows: rows.filter(row => row.position > Number(url.searchParams.get('since') ?? 0)).slice(0, 100), position: rows.length, generation: 1, computerState, computerRecovered, computerLostAt });
  });
  await page.routeWebSocket('**/ws', ws => {
    socket = ws;
    ws.onMessage(raw => {
      const input = JSON.parse(String(raw));
      for (const row of rows.filter(row => row.position > input.since)) ws.send(JSON.stringify({ version: 1, type: 'event', topic: 'conversation', conversationId: input.conversationId, generation: 1, position: row.position, row }));
      const computerState = fixtureComputerState(scenario);
      const computerRecovered = scenario === 'private-team-recovered';
      const computerLostAt = ['private-team-recovering', 'private-team-recovered'].includes(scenario)
        ? '2026-10-02T10:03:00.000Z' : undefined;
      ws.send(JSON.stringify({ version: 1, type: 'ready', topic: 'conversation', conversationId: input.conversationId, generation: 1, position: rows.length, computerState, computerRecovered, computerLostAt }));
      socketReady = true;
    });
  });
  async function waitForReadySocket() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (socketReady) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('The fixture socket did not send ready');
  }
  async function closeSocket() {
    await waitForReadySocket();
    socket?.close({ code: 1013, reason: 'fixture connection dropped' });
  }
  return {
    commands,
    add,
    closeSocket,
    conflictNextStop: () => { stopConflict = true; },
    online: () => { offline = false; },
    rows: () => rows,
  };
}

function fixtureComputerState(scenario) {
  if (scenario === 'private-team-recovering') return 'recovering';
  if (scenario === 'folding') return 'starting';
  return 'ready';
}
