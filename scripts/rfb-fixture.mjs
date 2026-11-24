export function rfbHandshake(width, height) {
  const version = Buffer.from('RFB 003.008\n');
  const securityTypes = Buffer.from([1, 1]);
  const securityAccepted = Buffer.alloc(4);
  const displayHeader = Buffer.alloc(24);
  displayHeader.writeUInt16BE(width, 0);
  displayHeader.writeUInt16BE(height, 2);
  displayHeader[4] = 32;
  displayHeader[5] = 24;
  displayHeader[7] = 1;
  displayHeader.writeUInt16BE(255, 8);
  displayHeader.writeUInt16BE(255, 10);
  displayHeader.writeUInt16BE(255, 12);
  displayHeader[14] = 16;
  displayHeader[15] = 8;
  const replies = [securityTypes, securityAccepted, displayHeader];
  return { version, replies };
}
