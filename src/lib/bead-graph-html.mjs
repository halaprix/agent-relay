import { STATUS_GLYPHS, STATUS_ORDER } from "./bead-graph.mjs";

// Fixed geometry: coordinates are computed here rather than by a layout library,
// so the page needs no script tag, no CDN, and no network. That is what makes the
// output diffable, archival, and safe to publish as an Artifact.
const NODE_WIDTH = 260;
const NODE_HEIGHT = 76;
const COLUMN_GAP = 96;
const ROW_GAP = 22;
const PADDING = 32;
// Lane for same-column and backward edges, kept smaller than PADDING so a routed
// edge never leaves the canvas.
const GUTTER_OFFSET = 18;
const HEADER_HEIGHT = 96;

const STATUS_COLORS = {
  blocked: "#c2410c",
  in_progress: "#b45309",
  open: "#2563eb",
  deferred: "#6b7280",
  closed: "#15803d"
};

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Deterministic truncation: no measurement, just a character budget for the fixed
// node width, so the same title always renders identically.
function truncate(text, budget) {
  return text.length <= budget ? text : `${text.slice(0, Math.max(0, budget - 1))}…`;
}

function layout(graph) {
  const positions = new Map();
  graph.layers.forEach((layer, columnIndex) => {
    layer.forEach((node, rowIndex) => {
      positions.set(node.id, {
        x: PADDING + columnIndex * (NODE_WIDTH + COLUMN_GAP),
        y: HEADER_HEIGHT + rowIndex * (NODE_HEIGHT + ROW_GAP)
      });
    });
  });
  const tallest = Math.max(1, ...graph.layers.map((layer) => layer.length));
  return {
    positions,
    width: PADDING * 2 + Math.max(1, graph.layers.length) * (NODE_WIDTH + COLUMN_GAP) - COLUMN_GAP,
    height: HEADER_HEIGHT + tallest * (NODE_HEIGHT + ROW_GAP) - ROW_GAP + PADDING
  };
}

function renderEdge(edge, positions) {
  const from = positions.get(edge.from);
  const to = positions.get(edge.to);
  if (!from || !to) {
    return "";
  }
  const startY = from.y + NODE_HEIGHT / 2;
  const endY = to.y + NODE_HEIGHT / 2;
  let path;
  if (to.x === from.x) {
    // Same column - an epic and the children it contains. Run the edge down the
    // gutter to the left of the column. Anchoring right-to-left here would cross the
    // boxes, and a bezier between the two anchors would leave the canvas entirely.
    const gutter = from.x - GUTTER_OFFSET;
    path = `M ${from.x} ${startY} H ${gutter} V ${endY} H ${to.x}`;
  } else if (to.x > from.x) {
    const startX = from.x + NODE_WIDTH;
    const midX = (startX + to.x) / 2;
    path = `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${to.x} ${endY}`;
  } else {
    // Backward across columns: drop below the source row and return, staying inside
    // the canvas rather than routing through negative coordinates.
    const startX = from.x + NODE_WIDTH;
    const laneY = Math.max(startY, endY) + NODE_HEIGHT;
    path = `M ${startX} ${startY} V ${laneY} H ${to.x - GUTTER_OFFSET} V ${endY} H ${to.x}`;
  }
  const className = edge.kind === "containment" ? "edge containment" : "edge ordering";
  return `<path class="${className}" d="${path}" marker-end="url(#arrow-${edge.kind})" />`;
}

function renderNode(node, position) {
  const color = STATUS_COLORS[node.status];
  const priority = node.priority ? ` · ${node.priority}` : "";
  const isEpic = node.type === "epic";
  return [
    `<g class="node" transform="translate(${position.x} ${position.y})">`,
    `<rect class="node-box${isEpic ? " epic" : ""}" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="10" />`,
    `<rect class="node-stripe" width="4" height="${NODE_HEIGHT}" rx="2" fill="${color}" />`,
    `<text class="node-id" x="16" y="26">${escapeXml(STATUS_GLYPHS[node.status])} ${escapeXml(node.id)}${escapeXml(priority)}</text>`,
    `<text class="node-title" x="16" y="48">${escapeXml(truncate(node.title, 34))}</text>`,
    isEpic ? `<text class="node-kind" x="16" y="66">epic</text>` : "",
    "</g>"
  ]
    .filter(Boolean)
    .join("\n");
}

function renderLegend(graph) {
  const present = STATUS_ORDER.filter((status) => graph.counts[status] > 0);
  return present
    .map(
      (status) =>
        `<span class="legend-item"><span class="swatch" style="background:${STATUS_COLORS[status]}"></span>${escapeXml(STATUS_GLYPHS[status])} ${status.replace("_", " ")} ${graph.counts[status]}</span>`
    )
    .join("\n");
}

export function renderBeadGraphHtml(graph, { title = "Bead graph", generatedFor = null } = {}) {
  const { positions, width, height } = layout(graph);
  const heading = graph.rootId ? `${graph.rootId}` : "all beads";
  const rootNode = graph.rootId ? graph.nodes.get(graph.rootId) : null;
  const columns = graph.layers
    .map(
      (layer, index) =>
        `<text class="column-label" x="${PADDING + index * (NODE_WIDTH + COLUMN_GAP)}" y="${HEADER_HEIGHT - 22}">layer ${index} · ${layer.length}</text>`
    )
    .join("\n");

  return `<title>${escapeXml(title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --fg: #111827;
    --muted: #6b7280;
    --card: #f9fafb;
    --border: #d1d5db;
    --edge: #9ca3af;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0f19;
      --fg: #e5e7eb;
      --muted: #9ca3af;
      --card: #151b28;
      --border: #2b3444;
      --edge: #4b5563;
    }
  }
  :root[data-theme="dark"] {
    --bg: #0b0f19;
    --fg: #e5e7eb;
    --muted: #9ca3af;
    --card: #151b28;
    --border: #2b3444;
    --edge: #4b5563;
  }
  :root[data-theme="light"] {
    --bg: #ffffff;
    --fg: #111827;
    --muted: #6b7280;
    --card: #f9fafb;
    --border: #d1d5db;
    --edge: #9ca3af;
  }
  body {
    margin: 0;
    padding: 24px;
    background: var(--bg);
    color: var(--fg);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header { margin-bottom: 16px; }
  h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: -0.01em; }
  .subtitle { color: var(--muted); margin: 0 0 12px; }
  .legend { display: flex; flex-wrap: wrap; gap: 14px; color: var(--muted); font-size: 13px; }
  .legend-item { display: inline-flex; align-items: center; gap: 6px; }
  .swatch { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .canvas { overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; background: var(--card); }
  svg { display: block; }
  .node-box { fill: var(--bg); stroke: var(--border); }
  .node-box.epic { stroke-width: 2; stroke-dasharray: 6 3; }
  .node-id { font: 600 13px ui-monospace, SFMono-Regular, Menlo, monospace; fill: var(--fg); }
  .node-title { font-size: 13px; fill: var(--fg); }
  .node-kind { font-size: 11px; fill: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; }
  .column-label { font-size: 11px; fill: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; }
  .edge { fill: none; stroke: var(--edge); stroke-width: 1.5; }
  .edge.containment { stroke-dasharray: 3 4; }
  .warning { margin-top: 16px; padding: 12px 14px; border-radius: 10px; border: 1px solid #c2410c; color: #c2410c; }
  footer { margin-top: 16px; color: var(--muted); font-size: 12px; }
</style>
<header>
  <h1>${escapeXml(heading)}${rootNode ? ` — ${escapeXml(rootNode.title)}` : ""}</h1>
  <p class="subtitle">${graph.nodes.size} beads · ${graph.edges.length} edges · layer 0 is startable work</p>
  <div class="legend">
${renderLegend(graph)}
    <span class="legend-item">── blocks</span>
    <span class="legend-item">┄┄ parent-child</span>
  </div>
</header>
<div class="canvas">
<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(heading)} dependency graph">
  <defs>
    <marker id="arrow-ordering" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--edge)" />
    </marker>
    <marker id="arrow-containment" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--edge)" />
    </marker>
  </defs>
${columns}
${graph.edges.map((edge) => renderEdge(edge, positions)).join("\n")}
${[...graph.nodes.values()]
  .filter((node) => positions.has(node.id))
  .map((node) => renderNode(node, positions.get(node.id)))
  .join("\n")}
</svg>
</div>
${
  graph.cycleEdges.length > 0
    ? `<div class="warning"><strong>Dependency cycle:</strong> ${escapeXml(graph.cycleEdges.join(", "))}. Those beads are pinned to layer 0 because no ordering exists. Run <code>bd dep cycles</code>.</div>`
    : ""
}
<footer>Generated by <code>relay graph</code>${generatedFor ? ` for ${escapeXml(generatedFor)}` : ""}. Self-contained: no scripts, no external requests.</footer>
`;
}
