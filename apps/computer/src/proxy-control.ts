import { request, type IncomingMessage } from 'node:http';

export function proxyControl(path: string, input: unknown, socketPath = '/run/codex/control.sock') {
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
    const outgoing = request({ socketPath, path, method: 'POST' }, receive);
    function timeout() { outgoing.destroy(new Error('Proxy control request timed out')); }
    outgoing.on('error', reject);
    outgoing.setTimeout(5000, timeout);
    outgoing.end(JSON.stringify(input));
  }
  return new Promise<void>(send);
}
