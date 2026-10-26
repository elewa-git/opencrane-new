import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import type { EventEnvelope } from '@opencrane/events';
import { z } from 'zod';
import { assertComputerLabels, assertHomeOwnership, isFullySuspended }
  from '../../apps/ops/src/kubernetes.ts';
import { captureBounds, descriptorSchema } from './event-backup.ts';
import { checkHistory, readPrivateFile, restoreEventBackup } from './event-restore.ts';

interface Options {
  directory: string;
  silo: string;
  attempt: string;
  disposable: boolean;
  namespace: string;
  namespaceUid: string;
  kubeconfig: string;
  context: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}
type Request = Pick<Options, 'namespace' | 'kubeconfig' | 'context'> & {
  resource: 'namespace' | 'sandboxes' | 'persistentvolumeclaims' | 'pods';
  signal: AbortSignal;
};
const execute = promisify(execFile);
const maximumBytes = 64 * 1024 * 1024;
const replyBytes = 2 * 1024 * 1024;
const identifier = z.string().regex(/^[a-zA-Z0-9_.:-]{1,253}$/);
const labels = z.record(z.string(), z.string());
const referenceSchema = z.object({ name: identifier, uid: identifier, resourceVersion: identifier });
const resourceSchema = z.object({ kind: z.string(), metadata: referenceSchema.extend({
  namespace: identifier.optional(), generation: z.number().int().positive().optional(),
  deletionTimestamp: z.never().optional(), labels: labels.optional(),
  ownerReferences: z.array(z.object({ uid: identifier, kind: z.string().optional(),
    name: identifier.optional(), controller: z.boolean().optional() })).optional(),
}), spec: z.object({ operatingMode: z.string().optional(),
  podTemplate: z.object({ metadata: z.object({ labels }) }).optional(),
  volumes: z.array(z.object({ persistentVolumeClaim: z.object({ claimName: identifier })
    .optional() })).optional(),
}).optional(), status: z.object({ conditions: z.array(z.object({
  type: z.string(), status: z.string(), reason: z.string().optional(),
  observedGeneration: z.number().int().optional(),
})).optional() }).optional() });
const listSchema = z.object({ metadata: z.object({ resourceVersion: identifier,
  continue: z.literal('').optional(), remainingItemCount: z.literal(0).optional(),
}), items: z.array(resourceSchema).max(10_000) });
const computerSchema = z.object({ assistantId: identifier, computerId: identifier,
  generation: z.number().int().positive().optional(), sandboxUid: identifier.optional() });
type Computer = z.infer<typeof computerSchema> & { generation: number };
type Resource = z.infer<typeof resourceSchema>;
type Bounds = ReturnType<typeof captureBounds>;
type Connection = Parameters<typeof restoreEventBackup>[0];

function refusal() {
  return new Error('Computer volume inventory refused');
}
function digest(bytes: Buffer) {
  const hash = createHash('sha256');
  hash.update(bytes);
  return hash.digest('hex');
}

function requiredComputers() {
  const assistants = new Set<string>();
  const computers = new Map<string, Computer>();
  const owners = new Map<string, string>();
  function visit(event: EventEnvelope) {
    if (event.type === 'assistant.created') {
      const assistant = z.object({ assistantId: identifier }).parse(event.data);
      if (event.subject !== `assistant-${assistant.assistantId}` ||
          assistants.has(assistant.assistantId) || assistants.size >= 1_000) throw refusal();
      assistants.add(assistant.assistantId);
      return;
    }
    const lifecycle = ['computer.claimed', 'computer.ready', 'computer.resumed',
      'computer.suspended', 'computer.lost', 'computer.retired'];
    if (!lifecycle.includes(event.type)) return;
    const data = computerSchema.parse(event.data);
    const previous = computers.get(data.assistantId);
    if (!assistants.has(data.assistantId) || event.subject !== `computer-${data.assistantId}` ||
        (previous && previous.computerId !== data.computerId)) throw refusal();
    if (event.type === 'computer.claimed') {
      if (data.generation !== (previous?.generation ?? 0) + 1 ||
          (owners.has(data.computerId) && owners.get(data.computerId) !== data.assistantId)) {
        throw refusal();
      }
      owners.set(data.computerId, data.assistantId);
      computers.set(data.assistantId, { ...data, generation: data.generation });
      return;
    }
    if (event.type === 'computer.ready' && (!data.generation || !data.sandboxUid)) throw refusal();
    if (!previous || (data.generation !== undefined && data.generation !== previous.generation)) {
      throw refusal();
    }
    if (data.sandboxUid) {
      if (previous.sandboxUid && previous.sandboxUid !== data.sandboxUid) throw refusal();
      previous.sandboxUid = data.sandboxUid;
    }
    // Keep lost and retired homes: neither event proves that retained storage was removed.
  }
  return { computers, visit };
}

async function readKubernetes(request: Request) {
  const args = ['--context', request.context, '--namespace', request.namespace,
    '--request-timeout=8s', 'get', request.resource];
  if (request.resource === 'namespace') args.push(request.namespace);
  args.push('-o', 'json');
  const env = { ...process.env, KUBECONFIG: request.kubeconfig };
  const options = { env, signal: request.signal, timeout: 10_000,
    killSignal: 'SIGKILL' as const, maxBuffer: replyBytes };
  const result = await execute('kubectl', args, options);
  return result.stdout;
}

function checkedList(input: unknown, namespace: string, kind: string) {
  const list = listSchema.parse(input);
  const names = new Set<string>();
  const uids = new Set<string>();
  for (const resource of list.items) {
    const metadata = resource.metadata;
    if (resource.kind !== kind || metadata.namespace !== namespace ||
        names.has(metadata.name) || uids.has(metadata.uid)) throw refusal();
    names.add(metadata.name);
    uids.add(metadata.uid);
  }
  return list.items;
}

function checkNoPod(pods: Resource[], computer: Computer) {
  for (const pod of pods) {
    if (!pod.spec) throw refusal();
    function owned(owner: { uid: string }) { return owner.uid === computer.sandboxUid; }
    if (pod.metadata.name === computer.computerId ||
        pod.metadata.labels?.['sandbox.users.io/computer'] === computer.computerId ||
        pod.metadata.ownerReferences?.some(owned)) throw refusal();
    for (const volume of pod.spec?.volumes ?? []) {
      if (volume.persistentVolumeClaim?.claimName === `home-${computer.computerId}`) throw refusal();
    }
  }
}

function matchHome(computer: Computer, sandboxes: Resource[], claims: Resource[], pods: Resource[]) {
  function matchesSandbox(resource: Resource) {
    const labels = resource.spec?.podTemplate?.metadata.labels;
    return resource.metadata.name === computer.computerId ||
      labels?.['sandbox.users.io/computer'] === computer.computerId ||
      labels?.['sandbox.users.io/assistant'] === computer.assistantId;
  }
  function matchesHome(resource: Resource) {
    function owned(owner: { uid: string }) { return owner.uid === computer.sandboxUid; }
    return resource.metadata.name === `home-${computer.computerId}` ||
      resource.metadata.labels?.['sandbox.users.io/computer'] === computer.computerId ||
      resource.metadata.ownerReferences?.some(owned);
  }
  const matchingSandboxes = sandboxes.filter(matchesSandbox);
  const matchingHomes = claims.filter(matchesHome);
  const sandbox = matchingSandboxes[0];
  const home = matchingHomes[0];
  if (matchingSandboxes.length !== 1 || matchingHomes.length !== 1 || !sandbox || !home ||
      sandbox.metadata.name !== computer.computerId ||
      home.metadata.name !== `home-${computer.computerId}` ||
      sandbox.metadata.uid !== computer.sandboxUid || !sandbox.metadata.generation ||
      !isFullySuspended(sandbox)) throw refusal();
  assertComputerLabels(sandbox, computer.computerId, computer.assistantId);
  assertHomeOwnership(home, sandbox, computer.computerId);
  checkNoPod(pods, computer);
  return { assistantId: computer.assistantId, computerId: computer.computerId,
    generation: computer.generation, sandbox: referenceSchema.parse(sandbox.metadata),
    home: referenceSchema.parse(home.metadata) };
}

/** Return private metadata only; keep writers stopped until later byte capture has finished. */
export async function collectComputerVolumeInventory(source: Connection, target: Connection,
  options: Options, read: (request: Request) => Promise<string> = readKubernetes) {
  let sourceBounds: Bounds | undefined;
  let targetBounds: Bounds | undefined;
  const controller = new AbortController();
  try {
    const timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
        !options.kubeconfig || !options.context) throw refusal();
    identifier.parse(options.namespaceUid);
    z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/).max(63).parse(options.namespace);
    const signals = [controller.signal, AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    sourceBounds = captureBounds(source, { signal, timeoutMs });
    targetBounds = captureBounds(target, { signal, timeoutMs });
    const restored = await restoreEventBackup(source, target, { ...options, signal, timeoutMs });
    const { descriptor, targetDescriptor } = restored;
    if (descriptor.attempt !== options.attempt) throw refusal();
    const required = requiredComputers();
    await checkHistory(targetBounds, targetDescriptor, maximumBytes, required.visit);
    const bounds = sourceBounds;
    async function request(resource: Request['resource']) {
      bounds.check();
      const input = { resource, namespace: options.namespace, kubeconfig: options.kubeconfig,
        context: options.context, signal };
      const text = await bounds.bounded(read(input));
      if (Buffer.byteLength(text) > replyBytes) throw refusal();
      return JSON.parse(text) as unknown;
    }
    async function observe() {
      const namespace = resourceSchema.parse(await request('namespace'));
      if (namespace.kind !== 'Namespace' || namespace.metadata.name !== options.namespace ||
          namespace.metadata.uid !== options.namespaceUid) throw refusal();
      const sandboxes = checkedList(await request('sandboxes'), options.namespace, 'Sandbox');
      const claims = checkedList(await request('persistentvolumeclaims'), options.namespace,
        'PersistentVolumeClaim');
      const pods = checkedList(await request('pods'), options.namespace, 'Pod');
      const volumes = [];
      for (const computer of required.computers.values()) {
        volumes.push(matchHome(computer, sandboxes, claims, pods));
      }
      return { namespace: referenceSchema.parse(namespace.metadata), volumes };
    }
    const before = await observe();
    await checkHistory(sourceBounds, descriptor, maximumBytes);
    await checkHistory(targetBounds, targetDescriptor, maximumBytes);
    const after = await observe();
    if (!isDeepStrictEqual(before, after)) throw refusal();
    // Refuse changed files as well as changed resources before returning any inventory.
    const saved = readPrivateFile(join(options.directory, 'descriptor.json'), 1024 * 1024);
    const current = descriptorSchema.parse(JSON.parse(saved.toString('utf8')));
    const archive = readPrivateFile(join(options.directory, 'events.snapshot'), maximumBytes);
    if (!isDeepStrictEqual(current, descriptor) || archive.length !== descriptor.byteCount ||
        digest(archive) !== descriptor.sha256) throw refusal();
    await checkHistory(sourceBounds, descriptor, maximumBytes);
    await checkHistory(targetBounds, targetDescriptor, maximumBytes);
    sourceBounds.check();
    targetBounds.check();
    return { kind: 'computer-volume-inventory-only', silo: descriptor.silo,
      attempt: descriptor.attempt, eventArchiveSha256: descriptor.sha256,
      eventDescriptorSha256: digest(saved), ...after };
  } catch {
    throw refusal();
  } finally {
    controller.abort();
    sourceBounds?.dispose();
    targetBounds?.dispose();
  }
}
