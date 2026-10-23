import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

type ObjectRecord = { kind: string; metadata: { name: string; uid: string;
  labels?: Record<string, string> }; spec?: unknown; status?: unknown };
export function hostedFixture(environment = { MCP_HOSTED_K3D: '1', DEV_STACK_ID: '1' }) {
  const objects = new Map<string, ObjectRecord>();
  const calls: string[][] = [];
  const cases = new Map<string, () => Promise<void>>();
  let setup: () => Promise<void>;
  let cleanup: () => Promise<void>;
  let failedName = '';
  let lostResponseName = '';
  let staleQuota = 0;
  let sleeps = 0;
  let sequence = 0;
  function expect(value: unknown) {
    return {
      toBe(expected: unknown) {
        assert.equal(value, expected);
      },
      toContain(expected: unknown) {
        assert.ok((value as string[]).includes(expected as string));
      },
      toHaveLength(expected: number) {
        assert.equal((value as unknown[]).length, expected);
      },
      toThrow(expected: RegExp | string) {
        function matches(error: Error) {
          if (expected instanceof RegExp || typeof expected !== 'string') {
            assert.match(error.message, expected);
          } else assert.ok(error.message.includes(expected), error.message);
          return true;
        }
        assert.throws(value as () => void, matches);
      },
      not: {
        toBe(expected: unknown) {
          assert.notEqual(value, expected);
        },
      },
    };
  }
  function it(name: string, action: () => Promise<void>) {
    cases.set(name, action);
  }
  function register() {}
  it.each = function each() {
    return register;
  };
  function create(object: ObjectRecord) {
    const key = `${object.kind.toLowerCase()}/${object.metadata.name}`;
    if (object.metadata.name === failedName && object.kind.endsWith('Binding')) {
      throw new Error('private fixture create failure');
    }
    if (objects.has(key)) throw new Error('already exists');
    sequence++;
    object.metadata.uid = `uid-${sequence}`;
    objects.set(key, object);
    if (object.metadata.name === lostResponseName) {
      throw new Error('private-create-response');
    }
    return JSON.stringify(object);
  }
  function manifests(namespace: string) {
    const result = [];
    for (const suffix of ['statefulset', 'pod', 'scale']) {
      const metadata = { name: `${namespace}-${suffix}`, uid: '' };
      const policy = { kind: 'ValidatingAdmissionPolicy', metadata: { ...metadata },
        spec: { validations: [{ expression: '!has(variables.container.command)' }] } };
      const binding = { kind: 'ValidatingAdmissionPolicyBinding', metadata: { ...metadata } };
      result.push(policy, binding);
    }
    return result;
  }
  function execute(binary: string, args: string[], options: { input?: string }) {
    calls.push([binary, ...args]);
    if (binary === 'node') {
      if (args[0]?.includes('mcp-resources')) return '';
      const policies = manifests(args[1]!);
      if (args.includes('--render')) return JSON.stringify({ items: policies });
      for (const policy of policies) create(policy);
      return '';
    }
    const offset = args.findIndex(isVerb);
    const command = args.slice(offset);
    const [verb, resource, name] = command;
    if (verb === 'create' && resource === 'namespace') {
      const object = { kind: 'Namespace', metadata: { name: name!, uid: '' } };
      return create(object);
    }
    if (verb === 'get') {
      const key = resource!.includes('/') ? resource! : `${resource}/${name}`;
      if (resource!.startsWith('resourcequota')) {
        if (staleQuota > 0) {
          staleQuota--;
          return '1';
        }
        return '0';
      }
      const object = objects.get(key);
      if (!object) return '';
      if (command.includes('jsonpath={.metadata.uid}')) return object.metadata.uid;
      return JSON.stringify(object);
    }
    if (verb === 'delete') {
      if (resource === 'pod' && name === 'mcp') {
        if (!command.includes('--wait=true')) throw new Error('Resize returned before deletion');
        staleQuota = 2;
      }
      const kinds = resource!.split(',');
      const candidates = command.slice(2);
      const names = candidates.filter(isName);
      for (const kind of kinds) {
        for (const item of names) objects.delete(`${kind}/${item}`);
      }
      return '';
    }
    if ((verb === 'create' || verb === 'apply') && options.input) {
      const object = JSON.parse(options.input) as ObjectRecord;
      if (command.includes('--dry-run=server')) {
        throw new Error('denied: Hosted MCP check 0 requires the approved template or identity');
      }
      if (object.kind.startsWith('Validating')) return create(object);
      if (object.kind === 'Pod' && staleQuota > 0) throw new Error('Quota usage has not settled');
    }
    if (verb === 'patch' && command.includes('--subresource=resize')) {
      const body = JSON.parse(command[command.indexOf('-p') + 1]!) as {
        spec: { containers: [{ resources: { limits: { cpu: string } } }] }
      };
      if (body.spec.containers[0].resources.limits.cpu === '2') {
        throw new Error('denied: Hosted MCP check 0 requires the approved template or identity');
      }
    }
    return '';
  }
  function isVerb(value: string) {
    return ['create', 'apply', 'get', 'delete', 'patch', 'auth'].includes(value);
  }
  function isName(value: string) {
    return !value.startsWith('--');
  }
  function spawnSync(binary: string, args: string[], options: { input?: string }) {
    try {
      const stdout = execute(binary, args, options);
      return { status: 0, stdout, stderr: '' };
    } catch (error) {
      return { status: 1, stdout: '', stderr: (error as Error).message };
    }
  }
  function read(path: string, encoding: 'utf8') {
    if (path.endsWith('stack-owner')) return `worktree=${resolve('.')}\n`;
    return readFileSync(path, encoding);
  }
  async function delay() {
    sleeps++;
  }
  function beforeAll(action: typeof setup) {
    setup = action;
  }
  function afterAll(action: typeof cleanup) {
    cleanup = action;
  }
  function describe(_name: string, action: () => void) {
    action();
  }
  function skipIf() {
    return describe;
  }
  const sourcePath = new URL('../../../apps/ops/test/mcp-hosted-k3d.test.ts', import.meta.url);
  const original = readFileSync(sourcePath, 'utf8');
  const withoutImports = original.replace(/^import[\s\S]*?;\n/gmu, '');
  const guardPath = new URL('../journey-guard.ts', import.meta.url);
  const guard = readFileSync(guardPath, 'utf8');
  const guardSource = guard.replaceAll('export function', 'function');
  const source = stripTypeScriptTypes(`${guardSource}\n${withoutImports}`);
  function randomUUID() {
    return 'fixture-id';
  }
  function homedir() {
    return '/fixture';
  }
  function join(...parts: string[]) {
    return parts.join('/');
  }
  const context = { spawnSync, randomUUID, readFileSync: read, homedir, join, resolve,
    delay, afterAll, beforeAll, describe: { skipIf }, expect, it, structuredClone,
    process: { env: environment }, console };
  runInNewContext(source, context);
  async function initialise() {
    await setup();
  }
  async function finish() {
    await cleanup();
  }
  return { objects, calls, cases, setup: initialise, cleanup: finish,
    loseCreateResponse(name: string) {
      lostResponseName = name;
    },
    failBinding(name: string) {
      failedName = name;
    },
    holdQuota() {
      staleQuota = Infinity;
    },
    get sleeps() {
      return sleeps;
    },
  };
}
