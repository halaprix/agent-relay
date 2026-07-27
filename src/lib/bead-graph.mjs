import { epicIdFor } from "./beads.mjs";

// Dependency semantics, as bd exports them: each entry lives on the dependent
// issue, so `depends_on_id` is the thing that comes first. For `parent-child`
// that makes it the parent; for `blocks` it is the blocker.
const CONTAINMENT_TYPE = "parent-child";
const ORDERING_TYPES = new Set(["blocks", "depends-on"]);

const STATUS_GLYPHS = {
  open: "○",
  in_progress: "◐",
  blocked: "●",
  closed: "✓",
  deferred: "❄"
};

const STATUS_ORDER = ["blocked", "in_progress", "open", "deferred", "closed"];

function normalizeStatus(raw) {
  const value = String(raw || "open").toLowerCase();
  return STATUS_GLYPHS[value] ? value : "open";
}

function normalizePriority(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return `P${Math.trunc(raw)}`;
  }
  const value = String(raw ?? "").trim();
  return /^P\d$/i.test(value) ? value.toUpperCase() : "";
}

// Records and their dependency arrays arrive in whatever order the store returns.
// Sorting by id everywhere is what makes the rendered bytes reproducible.
function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function buildBeadGraph(records, { rootId = null } = {}) {
  const nodes = new Map();
  for (const record of records) {
    nodes.set(record.id, {
      id: record.id,
      title: String(record.title || "").trim(),
      status: normalizeStatus(record.status),
      priority: normalizePriority(record.priority),
      type: String(record.issue_type || "task"),
      parent: null
    });
  }

  const edges = [];
  for (const record of [...records].sort(byId)) {
    const dependencies = Array.isArray(record.dependencies) ? record.dependencies : [];
    for (const dependency of dependencies) {
      const from = dependency?.depends_on_id;
      const to = dependency?.issue_id || record.id;
      const type = String(dependency?.type || "");
      if (!from || !to || !nodes.has(from) || !nodes.has(to)) {
        continue;
      }
      if (type === CONTAINMENT_TYPE) {
        nodes.get(to).parent = from;
        edges.push({ from, to, kind: "containment" });
        continue;
      }
      if (ORDERING_TYPES.has(type)) {
        edges.push({ from, to, kind: "ordering" });
      }
      // Anything else (relates-to and friends) is an annotation, not structure.
    }
  }

  const selected = selectSubgraph(nodes, rootId);
  const selectedEdges = edges
    .filter((edge) => selected.has(edge.from) && selected.has(edge.to))
    .sort((a, b) => byId(a, b) || byId({ id: a.from }, { id: b.from }) || a.kind.localeCompare(b.kind));

  const { layers, cycleEdges } = layerNodes(selected, selectedEdges);
  return {
    rootId,
    nodes: selected,
    edges: selectedEdges,
    layers,
    cycleEdges,
    counts: countByStatus(selected)
  };
}

// A bead id selects that bead plus everything beneath it. Falls back to the whole
// store when no id is given.
function selectSubgraph(nodes, rootId) {
  if (!rootId) {
    return new Map([...nodes.entries()].sort((a, b) => byId(a[1], b[1])));
  }
  if (!nodes.has(rootId)) {
    throw new Error(`bead ${rootId} is not in the exported store`);
  }
  const selected = new Map();
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (selected.has(current)) {
      continue;
    }
    selected.set(current, nodes.get(current));
    for (const [id, node] of nodes) {
      if (node.parent === current) {
        queue.push(id);
      }
    }
  }
  return new Map([...selected.entries()].sort((a, b) => byId(a[1], b[1])));
}

// Longest-path layering over ordering edges only: a node sits one layer right of
// its latest blocker, so layer 0 is startable work. Containment is drawn but never
// pushes a child rightward - an epic is not a blocker of its own children.
//
// Kahn's algorithm rather than recursion, so a dependency cycle surfaces as
// leftover nodes instead of an unbounded stack. The leftovers are reported, pinned
// to layer 0, and the offending edges named; bd allows a cycle to exist, so a
// renderer that threw on one could not draw the store at all.
function layerNodes(nodes, edges) {
  const ordering = edges.filter((edge) => edge.kind === "ordering");
  const indegree = new Map([...nodes.keys()].map((id) => [id, 0]));
  const outgoing = new Map([...nodes.keys()].map((id) => [id, []]));
  for (const edge of ordering) {
    indegree.set(edge.to, indegree.get(edge.to) + 1);
    outgoing.get(edge.from).push(edge.to);
  }

  const depth = new Map([...nodes.keys()].map((id) => [id, 0]));
  const ready = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort();
  const settled = new Set();
  while (ready.length > 0) {
    const current = ready.shift();
    settled.add(current);
    for (const next of outgoing.get(current).sort()) {
      depth.set(next, Math.max(depth.get(next), depth.get(current) + 1));
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }

  const cycleEdges = ordering
    .filter((edge) => !settled.has(edge.from) || !settled.has(edge.to))
    .map((edge) => `${edge.from} -> ${edge.to}`);
  for (const id of nodes.keys()) {
    if (!settled.has(id)) {
      depth.set(id, 0);
    }
  }

  const layers = [];
  for (const [id, node] of nodes) {
    const index = depth.get(id);
    layers[index] ||= [];
    layers[index].push(node);
  }
  // Order within a column by epic, then by id. Since containment is deliberately
  // flat, an epic and its children share a column, and grouping them puts a parent
  // directly above its own children - which keeps every containment edge a short
  // hop instead of a curve sweeping the height of the canvas. Status is already
  // carried by the glyph and the stripe, so it does not need to drive order too.
  for (const layer of layers) {
    layer.sort((a, b) => {
      const epicA = epicIdFor(a.id);
      const epicB = epicIdFor(b.id);
      return epicA < epicB ? -1 : epicA > epicB ? 1 : byId(a, b);
    });
  }
  return { layers: layers.map((layer) => layer || []), cycleEdges };
}

function countByStatus(nodes) {
  const counts = {};
  for (const status of STATUS_ORDER) {
    counts[status] = 0;
  }
  for (const node of nodes.values()) {
    counts[node.status] += 1;
  }
  return counts;
}

export { STATUS_GLYPHS, STATUS_ORDER, epicIdFor };
