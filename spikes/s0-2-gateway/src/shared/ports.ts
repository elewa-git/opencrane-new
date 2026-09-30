// Plain-English note: this file just lists which port each small service
// listens on, so every script and test uses the same numbers.

export const PORTS = {
  tokenIssuer: 4101,
  decisionService: 4102,
  mcpStub: 4103,
  modelStub: 4104,
  agentgateway: 3000,
  openfgaHttp: 8089,
  openfgaGrpc: 8090,
} as const;

export const URLS = {
  tokenIssuer: `http://127.0.0.1:${PORTS.tokenIssuer}`,
  decisionService: `http://127.0.0.1:${PORTS.decisionService}`,
  mcpStub: `http://127.0.0.1:${PORTS.mcpStub}`,
  modelStub: `http://127.0.0.1:${PORTS.modelStub}`,
  gateway: `http://127.0.0.1:${PORTS.agentgateway}`,
  openfga: `http://127.0.0.1:${PORTS.openfgaHttp}`,
} as const;

// The silo and identities used throughout this spike. Kept fixed and
// simple on purpose -- this is a spike, not a multi-tenant system.
export const FIXTURE = {
  silo: "acme",
  computer: "computer-alice",
  assistant: "assistant-alice",
  requester: "user-alice",
  otherUser: "user-mallory",
  conversation: "conv-1",
} as const;
