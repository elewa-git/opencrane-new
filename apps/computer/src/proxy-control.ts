import { request, type IncomingMessage } from 'node:http';

export function proxyControl(path: string, input: unknown,
  socketPath = '/run/codex/control.sock', controlKey = '') {
  function send(resolve: () => void, reject: (error: Error) => void) {
    function receive(response: IncomingMessage) {
      response.resume();
      function end() {
        if (response.statusCode === 200) resolve();
        else reject(new Error('Proxy control request refused'));
      }
      response.on('end', end);
      response.on('error', reject);
    }
    const headers = { authorization: `Bearer ${controlKey}` };
    const options = { socketPath, path, method: 'POST', headers };
    const outgoing = request(options, receive);
    function timeout() { outgoing.destroy(new Error('Proxy control request timed out')); }
    outgoing.on('error', reject);
    const timeoutMs = path === '/catalogue/ready' ? 11_000 : 5000;
    outgoing.setTimeout(timeoutMs, timeout);
    outgoing.end(JSON.stringify(input));
  }
  return new Promise<void>(send);
}

export function proxyGrants(control: (path: string, input: unknown) => Promise<void>,
  credential: () => { computer: string; generation: unknown }) {
  function grant(thread: string, conversation: string, token: string,
    expires: number, turnId: string) {
    const input = { thread, turnId, conversation, token, expires };
    if (!token) {
      return control('/drop', input);
    }
    const identity = credential();
    const request = { ...input, ...identity, inputGeneration: 1 };
    return control('/grant', request);
  }
  return grant;
}
