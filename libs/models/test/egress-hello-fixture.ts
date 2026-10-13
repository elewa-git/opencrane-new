function vector(bytes: Buffer, width = 2) {
  const length = Buffer.alloc(width);
  length.writeUIntBE(bytes.length, 0, width);
  return Buffer.concat([length, bytes]);
}
function serverName(host: string) {
  return Buffer.concat([Buffer.from([0]), vector(Buffer.from(host))]);
}
export function clientHello(names = ['registry.npmjs.org'], extra = Buffer.alloc(0)) {
  const entries = names.map(serverName);
  const list = vector(Buffer.concat(entries));
  const extension = Buffer.concat([Buffer.from([0, 0]), vector(list)]);
  const extensions = Buffer.concat([extension, extra]);
  const body = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32),
    Buffer.from([0, 0, 2, 0x13, 1, 1, 0]), vector(extensions)]);
  const handshake = Buffer.concat([Buffer.from([1]), vector(body, 3)]);
  return Buffer.concat([Buffer.from([22, 3, 1]), vector(handshake)]);
}
