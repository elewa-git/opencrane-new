import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function heapGraph(snapshot) {
  const { nodes, edges, strings } = snapshot;
  const { node_fields: nodeFields, edge_fields: edgeFields,
    edge_types: edgeTypes } = snapshot.snapshot.meta;
  const nodeWidth = nodeFields.length;
  const edgeWidth = edgeFields.length;
  const nameField = nodeFields.indexOf('name');
  const idField = nodeFields.indexOf('id');
  const countField = nodeFields.indexOf('edge_count');
  const typeField = edgeFields.indexOf('type');
  const edgeNameField = edgeFields.indexOf('name_or_index');
  const targetField = edgeFields.indexOf('to_node');
  const graph = [];
  const targets = new Map();
  let edgeOffset = 0;
  for (let offset = 0; offset < nodes.length; offset += nodeWidth) {
    const node = { name: strings[nodes[offset + nameField]],
      id: nodes[offset + idField], edges: [] };
    graph.push(node);
    const end = edgeOffset + nodes[offset + countField] * edgeWidth;
    for (; edgeOffset < end; edgeOffset += edgeWidth) {
      const type = edgeTypes[0][edges[edgeOffset + typeField]];
      const nameIndex = edges[edgeOffset + edgeNameField];
      let name = strings[nameIndex];
      if (type === 'element' || type === 'hidden') {
        name = String(nameIndex);
      }
      const targetOffset = edges[edgeOffset + targetField];
      if (type === 'property' && name === 'privateReplyProbe') {
        targets.set(offset / nodeWidth, strings[nodes[targetOffset + nameField]]);
      }
      // Exclude WeakRef targets. Follow a WeakMap's key-to-value edge only if its map is live.
      if (type !== 'weak') {
        const weakMap = /pair in WeakMap \(table @(\d+)\)/.exec(name);
        let owner;
        if (weakMap) {
          owner = Number(weakMap[1]);
        }
        const edge = { target: targetOffset / nodeWidth, name, owner };
        node.edges.push(edge);
      }
    }
  }
  return { graph, targets };
}

function pathsFromRoot(graph) {
  const parents = new Map([[0, null]]);
  const reachedIds = new Set([graph[0].id]);
  const waitingForMap = new Map();
  const queue = [0];
  function visit(source, edge) {
    if (!parents.has(edge.target)) {
      const parent = { source, name: edge.name };
      parents.set(edge.target, parent);
      reachedIds.add(graph[edge.target].id);
      queue.push(edge.target);
    }
  }
  for (let index = 0; index < queue.length; index += 1) {
    const source = queue[index];
    for (const edge of graph[source].edges) {
      if (edge.owner !== undefined && !reachedIds.has(edge.owner)) {
        const waiting = waitingForMap.get(edge.owner) ?? [];
        const pending = { source, edge };
        waiting.push(pending);
        waitingForMap.set(edge.owner, waiting);
      } else {
        visit(source, edge);
      }
    }
    const waiting = waitingForMap.get(graph[source].id) ?? [];
    for (const entry of waiting) {
      visit(entry.source, entry.edge);
    }
    waitingForMap.delete(graph[source].id);
  }
  return parents;
}

function describePath(graph, parents, target) {
  if (!parents.has(target)) {
    return 'no strong path from a heap root';
  }
  const steps = [];
  let current = target;
  while (parents.get(current)) {
    const { source, name } = parents.get(current);
    steps.push(`${graph[source].name || '(root)'} --${name}--> ${graph[current].name}`);
    current = source;
  }
  steps.reverse();
  return steps.join('\n  ');
}

export async function replyRetainers(session) {
  const chunks = [];
  function appendChunk(event) {
    chunks.push(event.chunk);
  }
  session.on('HeapProfiler.addHeapSnapshotChunk', appendChunk);
  try {
    await session.send('HeapProfiler.takeHeapSnapshot');
  } finally {
    session.off('HeapProfiler.addHeapSnapshotChunk', appendChunk);
  }
  const contents = chunks.join('');
  const file = join(tmpdir(), `private-reply-${process.pid}-${Date.now()}.heapsnapshot`);
  await writeFile(file, contents);
  const { graph, targets } = heapGraph(JSON.parse(contents));
  const parents = pathsFromRoot(graph);
  const retainers = [];
  for (const [target, label] of targets) {
    retainers.push(`${label}: ${describePath(graph, parents, target)}`);
  }
  if (retainers.length === 0) {
    retainers.push('All watched objects were collected while taking the snapshot.');
  }
  return `${retainers.join('\n')}\nHeap snapshot: ${file}`;
}
