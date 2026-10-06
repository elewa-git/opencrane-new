const approvalIds = ['a', 'b', 'c', 'd', 'e', 'f'];

export function approvalCard(index, state = 'requested', canDecide = true, requesterId) {
  return {
    approvalId: approvalIds[index].repeat(64),
    conversationId: 'chat',
    requesterId: requesterId ?? (canDecide ? 'me' : 'another-member'),
    expiresAt: '2026-10-04T10:32:00Z',
    state,
    stepUp: false,
    canDecide: state === 'requested' && canDecide,
    review: {
      action: 'Change the note on SO-1042',
      tool: 'update_draft_order_note',
      target: 'Draft order SO-1042',
      data: '{"note":"Deliver after 10:00 on Tuesday"}',
      destination: 'https://erp.example.test',
      account: 'No account · profile: none (credential-free connection)',
      consequence: 'Changes the draft note immediately; does not confirm the order.',
    },
  };
}

export async function approvalFixture(page, options) {
  const requests = [];
  const state = { cards: options.cards };
  await page.route('**/approvals', async route => {
    const request = route.request();
    const body = request.method() === 'POST' ? request.postDataJSON() : undefined;
    requests.push({ method: request.method(), body, headers: request.headers() });
    if (request.method() === 'POST') {
      const result = await options.onPost?.({ request, body, cards: state.cards, requests });
      const status = result?.status ?? 200;
      if (result?.cards) state.cards = result.cards;
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(result?.body ?? {}),
      });
      return;
    }
    const readResult = await options.onGet?.({ request, cards: state.cards, requests });
    if (readResult) {
      if (readResult.cards) state.cards = readResult.cards;
      await route.fulfill({
        status: readResult.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(readResult.body ?? { cards: state.cards, csrf: 'fixture' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cards: state.cards, csrf: 'fixture' }),
    });
  });
  return { requests, cards: () => state.cards, setCards: cards => { state.cards = cards; } };
}
