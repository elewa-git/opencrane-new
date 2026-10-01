// Tiny TCP relay, used by the spike scripts to reach a Pod that runs on the gVisor node pool.
//
// Why: GKE Sandbox does not support `kubectl port-forward` to sandboxed Pods. A relay Pod on a normal node
// forwards to the sandboxed Pod's IP, and `kubectl port-forward` goes to the relay Pod instead.
//
//   node tcp-relay.mjs 18080=10.1.2.3:8080 16901=10.1.2.3:6901
//
// Each argument is LISTEN_PORT=TARGET_HOST:TARGET_PORT. The relay listens on all interfaces of its own Pod.
// Targets must be private IPv4 addresses (10.x, 172.16-31.x, 192.168.x), so it cannot be turned into a way out.
import net from "node:net";

const PRIVATE = /^(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)$/;

const mappings = process.argv.slice(2).map((arg) => {
  const m = /^(\d+)=([^:]+):(\d+)$/.exec(arg);
  if (!m) throw new Error(`bad argument ${arg}; expected LISTEN_PORT=HOST:PORT`);
  if (!PRIVATE.test(m[2])) throw new Error(`target ${m[2]} is not a private IPv4 address`);
  return { listen: Number(m[1]), host: m[2], port: Number(m[3]) };
});
if (mappings.length === 0) throw new Error("no mappings given");

for (const { listen, host, port } of mappings) {
  net
    .createServer((client) => {
      const upstream = net.connect({ host, port });
      client.pipe(upstream).pipe(client);
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on("error", close);
      upstream.on("error", close);
      client.on("close", close);
      upstream.on("close", close);
    })
    .listen(listen, "0.0.0.0", () => console.log(`[relay] :${listen} -> ${host}:${port}`));
}
