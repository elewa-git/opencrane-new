export function closeFixtureServers(servers, sockets) {
  for (const server of servers) {
    server.close();
  }
  // Close CONNECT tunnels too; stopping the listener leaves those connections open.
  for (const socket of sockets) {
    socket.destroy();
  }
}
