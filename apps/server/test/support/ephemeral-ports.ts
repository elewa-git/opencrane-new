import { Server } from 'node:net';

// Angular probes and releases port 0 before Vite listens. In the browser fixture
// child, let every actual TCP listener bind port 0 too, then read its ready log.
// eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply forwards the original receiver.
Server.prototype.listen = new Proxy(Server.prototype.listen, {
  apply(target, server: unknown, args: unknown[]): unknown {
    const options = args[0];
    if (typeof options === 'number') args[0] = 0;
    else if (options && typeof options === 'object' && 'port' in options) {
      args[0] = { ...options, port: 0 };
    }
    return Reflect.apply(target, server, args);
  },
});
