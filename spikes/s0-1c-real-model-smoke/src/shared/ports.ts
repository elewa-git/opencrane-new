// Finds free TCP ports on 127.0.0.1, so several runs (and other spikes'
// tests running at the same time in this checkout) never fight over the
// same fixed port numbers.

import { createServer } from "node:net";

/** Asks the operating system for one currently free port on 127.0.0.1. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close();
        reject(new Error("could not read the free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

/** Asks for `count` distinct free ports. */
export async function freePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  while (ports.length < count) {
    const port = await freePort();
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}
