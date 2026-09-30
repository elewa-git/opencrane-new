// Plain helper: ask the OS for a free TCP port by binding to port 0 and
// reading back what we got, then closing again. Good enough for tests that
// need N non-clashing ports up front.
import { createServer } from "node:net";

export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address && typeof address === "object") {
        const { port } = address;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("could not read back a free port"));
      }
    });
  });
}

export async function freePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < count; i++) {
    ports.push(await freePort());
  }
  return ports;
}
