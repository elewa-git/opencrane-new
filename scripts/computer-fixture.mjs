function exposeFixtureSocketMethods() {
  const prototype = globalThis.WebSocket.prototype;
  const inherited = Object.getPrototypeOf(prototype);
  const properties = ['send', 'close', 'binaryType', 'onerror', 'onmessage', 'onopen'];
  // Playwright adds a subclass, but noVNC checks only its immediate prototype.
  for (const property of properties) {
    if (Object.hasOwn(prototype, property)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(inherited, property);
    if (descriptor) Object.defineProperty(prototype, property, descriptor);
  }
}

export async function computerFixture(page, options = {}) {
  const leaseUntilMs = options.leaseUntilMs ?? 1500;
  await page.evaluate(exposeFixtureSocketMethods);
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  let activeSocket;
  let leaseTimer;
  let release;
  function holdAdmission(resolve) { release = resolve; }
  const admission = new Promise(holdAdmission);
  async function admitView(route) {
    await admission;
    await route.fulfill({ json: { ticket: 'fixture-ticket' } });
  }
  function attachViewer(socket) {
    activeSocket = socket;
    const now = Date.now();
    const leaseLength = Math.min(leaseUntilMs, 1500);
    const accessNotice = JSON.stringify({ lease: 'valid', at: now, until: now + leaseLength });
    socket.send(accessNotice);
    if (leaseUntilMs > 1500) {
      leaseTimer = setInterval(renewLease, 1000);
      leaseTimer.unref();
    }
    let step = 0;
    function handshake() {
      if (step === 0) socket.send(Buffer.from([1, 1]));
      else if (step === 1) socket.send(Buffer.alloc(4));
      else if (step === 2) {
        const init = Buffer.alloc(24);
        init.writeUInt16BE(1024, 0);
        init.writeUInt16BE(768, 2);
        init[4] = 32;
        init[5] = 24;
        init[7] = 1;
        init.writeUInt16BE(255, 8);
        init.writeUInt16BE(255, 10);
        init.writeUInt16BE(255, 12);
        init[14] = 16;
        init[15] = 8;
        socket.send(init);
      }
      step++;
    }
    function disconnected() {
      clearInterval(leaseTimer);
      resolveClosed();
    }
    socket.onMessage(handshake);
    socket.onClose(disconnected);
  }
  function renewLease() {
    const at = Date.now();
    const until = at + 1500;
    activeSocket.send(JSON.stringify({ lease: 'valid', at, until }));
  }
  async function start() {
    const canvas = page.locator('oc-live-view .display canvas');
    await canvas.waitFor({ state: 'attached' });
    activeSocket.send(Buffer.from('RFB 003.008\n'));
  }
  function revoke() { activeSocket.close({ code: 4003, reason: 'Access changed' }); }
  function disconnect() { activeSocket.close({ code: 1001, reason: 'Fixture disconnected' }); }
  await page.route('**/api/conversations/*/view', admitView);
  await page.routeWebSocket('**/ws/conversations/*/view', attachViewer);
  return { closed, disconnect, revoke, release, start };
}
