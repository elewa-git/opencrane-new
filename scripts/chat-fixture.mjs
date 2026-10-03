// Protocol fixtures for visual qualification only; never imported into the product.
export async function chatFixture(page, scenario = 'live') {
  let stopConflict = false;
  let rows = [], socket, offline = ['queued', 'rail-offline'].includes(scenario);
  const add = (type, data) => {
    const row = { id: `event-${rows.length + 1}`, position: rows.length + 1, type, data, time: type === 'agent.turn_completed' ? '2026-10-02T10:42:48Z' : '2026-10-02T10:42:00Z' };
    rows.push(row);
    socket?.send(JSON.stringify({ version: 1, type: 'event', topic: 'conversation', conversationId: 'chat', generation: 1, position: row.position, row }));
    return row;
  };
  add('conversation.created', {});
  if (!['draft', 'attach', 'no-agent', 'queued'].includes(scenario)) {
    const human = add('message.posted', { text: scenario === 'long-title' ? 'M'.repeat(500) : 'Pull the Q3 board pack together. Focus on the revenue story and flag anything that needs a decision.', authorId: 'me' });
    add('agent.turn_started', { turnId: human.id });
    if (scenario !== 'folding') {
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
  const conversations = ['chat', 'research', 'done', 'closed', 'failed'].map((id, index) => ({ conversationId: id, assistantId: 'assistant', createdBy: 'me', mode: 'agent_session', createdAt: '2026-10-02T10:40:00Z',
    title: ['board-pack-q3', 'county-rollout', 'weekly-review', 'last-quarter', 'finance-export'][index], status: ['open', 'working', 'done', 'closed', 'failed'][index] }));
  const commands = [];
  await page.route('**/auth/me', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ authenticated: true, user: { name: 'Alex Morgan' } }) }));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const fulfil = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/chat' && offline && scenario === 'rail-offline') return route.abort('connectionfailed');
    if (url.pathname === '/api/chat' && scenario === 'rail-loading') return;
    if (url.pathname === '/api/chat') return fulfil({ memberId: 'me', displayName: 'Taylor Reed', assistantId: scenario === 'no-agent' ? null : 'assistant' });
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
    return fulfil({ rows: rows.filter(row => row.position > Number(url.searchParams.get('since') ?? 0)).slice(0, 100), position: rows.length, generation: 1, computerState: scenario === 'folding' ? 'starting your computer' : 'ready' });
  });
  await page.routeWebSocket('**/ws', ws => {
    socket = ws;
    ws.onMessage(raw => {
      const input = JSON.parse(String(raw));
      for (const row of rows.filter(row => row.position > input.since)) ws.send(JSON.stringify({ version: 1, type: 'event', topic: 'conversation', conversationId: input.conversationId, generation: 1, position: row.position, row }));
      ws.send(JSON.stringify({ version: 1, type: 'ready', topic: 'conversation', conversationId: input.conversationId, generation: 1, position: rows.length, computerState: scenario === 'folding' ? 'starting your computer' : 'ready' }));
    });
  });
  return { commands, add, conflictNextStop: () => { stopConflict = true; }, online: () => { offline = false; }, rows: () => rows };
}
