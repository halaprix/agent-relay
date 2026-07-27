import test from "node:test";
import assert from "node:assert/strict";
import { buildBeadGraph } from "../src/lib/bead-graph.mjs";
import { renderBeadGraphHtml } from "../src/lib/bead-graph-html.mjs";

// Dependency entries live on the dependent issue, so `depends_on_id` is whatever
// comes first: the parent for parent-child, the blocker for blocks.
function record(id, overrides = {}) {
  return {
    id,
    title: `Title for ${id}`,
    status: "open",
    priority: 1,
    issue_type: "task",
    dependencies: [],
    ...overrides
  };
}

function dependency(issueId, dependsOnId, type) {
  return { issue_id: issueId, depends_on_id: dependsOnId, type };
}

const EPIC_FIXTURE = [
  record("proj-1", { issue_type: "epic", title: "The epic", priority: 2 }),
  record("proj-1.1", { dependencies: [dependency("proj-1.1", "proj-1", "parent-child")] }),
  record("proj-1.2", {
    status: "blocked",
    priority: 0,
    dependencies: [
      dependency("proj-1.2", "proj-1", "parent-child"),
      dependency("proj-1.2", "proj-1.1", "blocks")
    ]
  }),
  record("proj-1.3", {
    status: "closed",
    dependencies: [
      dependency("proj-1.3", "proj-1", "parent-child"),
      dependency("proj-1.3", "proj-1.2", "blocks"),
      // relates-to is an annotation, not structure: it must not create an edge.
      dependency("proj-1.3", "proj-2", "relates-to")
    ]
  }),
  record("proj-2", { title: "Unrelated bead" })
];

test("buildBeadGraph layers ordering edges by longest path and keeps containment flat", () => {
  const graph = buildBeadGraph(EPIC_FIXTURE);
  const layerOf = (id) => graph.layers.findIndex((layer) => layer.some((node) => node.id === id));

  // Containment must not push a child rightward: an epic does not block its children.
  assert.equal(layerOf("proj-1"), 0);
  assert.equal(layerOf("proj-1.1"), 0);
  assert.equal(layerOf("proj-1.2"), 1);
  assert.equal(layerOf("proj-1.3"), 2);

  const kinds = graph.edges.map((edge) => `${edge.from}->${edge.to}:${edge.kind}`);
  assert.equal(kinds.includes("proj-1->proj-1.1:containment"), true);
  assert.equal(kinds.includes("proj-1.1->proj-1.2:ordering"), true);
  // relates-to produced nothing at all.
  assert.equal(
    kinds.some((kind) => kind.startsWith("proj-2->proj-1.3")),
    false
  );
  assert.deepEqual(graph.cycleEdges, []);
  assert.equal(graph.counts.blocked, 1);
  assert.equal(graph.counts.closed, 1);
});

test("buildBeadGraph restricted to a bead id keeps only that bead and its descendants", () => {
  const graph = buildBeadGraph(EPIC_FIXTURE, { rootId: "proj-1" });
  assert.deepEqual([...graph.nodes.keys()], ["proj-1", "proj-1.1", "proj-1.2", "proj-1.3"]);
  // The edge to the excluded bead is dropped rather than dangling.
  assert.equal(
    graph.edges.every((edge) => graph.nodes.has(edge.from) && graph.nodes.has(edge.to)),
    true
  );
  assert.throws(() => buildBeadGraph(EPIC_FIXTURE, { rootId: "proj-nope" }), /not in the exported store/);
});

test("buildBeadGraph reports a dependency cycle instead of looping forever", () => {
  const cyclic = [
    record("cyc-1", { dependencies: [dependency("cyc-1", "cyc-2", "blocks")] }),
    record("cyc-2", { dependencies: [dependency("cyc-2", "cyc-1", "blocks")] })
  ];
  const graph = buildBeadGraph(cyclic);
  assert.equal(graph.cycleEdges.length, 2);
  // Both are pinned to layer 0: no ordering exists, but the store must still draw.
  assert.equal(graph.layers.length, 1);
  assert.equal(graph.layers[0].length, 2);
});

test("buildBeadGraph is order-independent, so the same store always renders the same bytes", () => {
  const forward = renderBeadGraphHtml(buildBeadGraph(EPIC_FIXTURE));
  const reversed = renderBeadGraphHtml(buildBeadGraph([...EPIC_FIXTURE].reverse()));
  assert.equal(forward, reversed);
});

test("renderBeadGraphHtml emits a self-contained page with no scripts and no external hosts", () => {
  const html = renderBeadGraphHtml(buildBeadGraph(EPIC_FIXTURE, { rootId: "proj-1" }), {
    title: "proj-1 — bead graph"
  });
  assert.doesNotMatch(html, /<script/i);
  // The only allowed absolute URL is the SVG namespace, which is an identifier and
  // not a fetch. Anything else would break offline use and an Artifact's CSP.
  const urls = (html.match(/https?:\/\/[^"'\s)]+/g) || []).filter(
    (url) => url !== "http://www.w3.org/2000/svg"
  );
  assert.deepEqual(urls, []);
  // No wrapper tags: the page is Artifact-publishable as written.
  assert.doesNotMatch(html, /<!doctype|<html|<body/i);
  assert.match(html, /<title>proj-1 — bead graph<\/title>/);
  assert.match(html, /proj-1\.2/);
  assert.match(html, /prefers-color-scheme: dark/);
});

test("renderBeadGraphHtml escapes bead text instead of letting it inject markup", () => {
  const html = renderBeadGraphHtml(buildBeadGraph([record("esc-1", { title: 'a & b </text>' })]));
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /a &amp; b &lt;\/text&gt;/);

  // Titles are truncated before they are escaped, never after: escaping first would
  // let the character budget cut an entity in half and emit a bare `&am`.
  const long = "&".repeat(60);
  const truncated = renderBeadGraphHtml(buildBeadGraph([record("esc-2", { title: long })]));
  assert.doesNotMatch(truncated, /&(?!amp;|lt;|gt;|quot;)/);
  assert.doesNotMatch(truncated, /<script/i);
});

test("renderBeadGraphHtml keeps every edge inside the canvas", () => {
  // Containment is flat by design, so an epic and its children share a column and
  // their edges cannot be drawn between the usual right/left anchors: routing them
  // as a bezier put control points at negative coordinates and swept curves across
  // the whole canvas. They run down a gutter narrower than the padding instead.
  const html = renderBeadGraphHtml(buildBeadGraph(EPIC_FIXTURE));
  const coordinates = (html.match(/ d="([^"]+)"/g) || [])
    .join(" ")
    .match(/-?\d+(\.\d+)?/g)
    .map(Number);
  assert.equal(
    coordinates.every((value) => value >= 0),
    true,
    "an edge was routed through a negative coordinate"
  );

  const [, width, height] = html.match(/viewBox="0 0 (\d+) (\d+)"/).map(Number);
  assert.ok(width > 0 && height > 0);
  // Parents sort directly above their own children, which is what keeps a
  // same-column edge a short hop rather than a full-canvas sweep.
  const order = [...html.matchAll(/class="node-id"[^>]*>[^ ]+ (proj-[\d.]+)/g)].map((m) => m[1]);
  assert.deepEqual(order.slice(0, 4), ["proj-1", "proj-1.1", "proj-1.2", "proj-1.3"]);
});

test("renderBeadGraphHtml surfaces a cycle to the reader", () => {
  const cyclic = [
    record("cyc-1", { dependencies: [dependency("cyc-1", "cyc-2", "blocks")] }),
    record("cyc-2", { dependencies: [dependency("cyc-2", "cyc-1", "blocks")] })
  ];
  const html = renderBeadGraphHtml(buildBeadGraph(cyclic));
  assert.match(html, /Dependency cycle/);
  assert.match(html, /bd dep cycles/);
});
