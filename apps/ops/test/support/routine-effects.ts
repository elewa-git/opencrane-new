import { mock } from 'node:test';
import { EventStore } from '@opencrane/event-store';
import { HandlerRuntime } from '@opencrane/handlers';
import { SandboxClient } from '../../src/kubernetes.ts';
import * as auth from '@opencrane/auth';

function forbiddenEffect(): never {
  console.error('Forbidden routine replay effect');
  throw new Error('Forbidden routine replay effect');
}

// Fail the child process if replay tries to append, start jobs, issue passes or call a service.
mock.method(EventStore.prototype, 'append', forbiddenEffect);
mock.method(HandlerRuntime.prototype, 'start', forbiddenEffect);
mock.method(SandboxClient.prototype, 'mode', forbiddenEffect);
mock.method(SandboxClient.prototype, 'credentials', forbiddenEffect);
mock.method(globalThis, 'fetch', forbiddenEffect);
const authExports = { ...auth, tokenIssuer: forbiddenEffect };
mock.module('@opencrane/auth', { namedExports: authExports });
