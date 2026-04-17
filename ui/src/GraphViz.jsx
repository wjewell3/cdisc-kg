/**
 * GraphViz — SVG schema diagram + query traversal path explainer.
 *
 * Default: Clean SVG showing 5 node types and their relationships.
 * On query: Highlights the traversal path with step-by-step flow and counts.
 */
import { useMemo } from "react";

// ── Schema layout — fixed positions for clean diagram ────────────────────────
const NODES = [
  { id: "Sponsor",      label: "Sponsor",      count: "49.9k",  x: 80,  y: 90,  color: "#818cf8", r: 32 },
  { id: "Trial",        label: "Trial",         count: "580k",   x: 280, y: 90,  color: "#38bdf8", r: 42 },
  { id: "Condition",    label: "Condition",     count: "129k",   x: 490, y: 40,  color: "#34d399", r: 36 },
  { id: "Intervention", label: "Intervention",  count: "512k",   x: 490, y: 145, color: "#fbbf24", r: 36 },
  { id: "Country",      label: "Country",       count: "225",    x: 280, y: 210, color: "#f472b6", r: 22 },
];

const EDGES = [
  { from: "Sponsor",  to: "Trial",        label: "RUNS",         count: "580k" },
  { from: "Trial",    to: "Condition",     label: "TREATS",       count: "1M"   },
  { from: "Trial",    to: "Intervention",  label: "USES",         count: "964k" },
  { from: "Trial",    to: "Country",       label: "CONDUCTED_IN", count: "754k" },
];

const NODE_MAP = Object.fromEntries(NODES.map(n => [n.id, n]));

// ── Per-preset query traversal path definitions ──────────────────────────────
const QUERY_PATHS = {
  g1: {
    title: "Therapeutic Adjacency",
    steps: [
      { type: "node", id: "Condition",    label: "Breast Cancer",       note: "start" },
      { type: "edge", label: "TREATS",    dir: "←" },
      { type: "node", id: "Trial",        label: "8,610 trials",        note: "" },
      { type: "edge", label: "USES",      dir: "→" },
      { type: "node", id: "Intervention", label: "top 100 drugs",       note: "" },
      { type: "edge", label: "USES",      dir: "←" },
      { type: "node", id: "Trial",        label: "other trials",        note: "" },
      { type: "edge", label: "TREATS",    dir: "→" },
      { type: "node", id: "Condition",    label: "adjacent conditions", note: "result" },
    ],
    highlight: ["Condition", "Trial", "Intervention"],
    highlightEdges: ["TREATS", "USES"],
    description: "Start at Breast Cancer → traverse shared interventions → discover therapeutically adjacent conditions.",
  },
  g2: {
    title: "Strategic Gap Detection",
    steps: [
      { type: "node", id: "Sponsor",   label: "Pfizer",             note: "start" },
      { type: "edge", label: "RUNS",   dir: "→" },
      { type: "node", id: "Trial",     label: "Pfizer's trials",    note: "" },
      { type: "edge", label: "TREATS", dir: "→" },
      { type: "node", id: "Condition", label: "Pfizer conditions",  note: "" },
      { type: "edge", label: "TREATS", dir: "←" },
      { type: "node", id: "Trial",     label: "adjacent trials",    note: "" },
      { type: "edge", label: "TREATS", dir: "→" },
      { type: "node", id: "Condition", label: "missing conditions", note: "result" },
    ],
    highlight: ["Sponsor", "Trial", "Condition"],
    highlightEdges: ["RUNS", "TREATS"],
    description: "Map Pfizer's portfolio → find conditions 1 hop away where Pfizer has zero trials.",
  },
  g3: {
    title: "Sponsor Aggregation",
    steps: [
      { type: "node", id: "Sponsor",   label: "all sponsors",        note: "result" },
      { type: "edge", label: "RUNS",   dir: "→" },
      { type: "node", id: "Trial",     label: "Phase 3 trials",      note: "filter" },
      { type: "edge", label: "TREATS", dir: "→" },
      { type: "node", id: "Condition", label: "oncology conditions", note: "filter" },
    ],
    highlight: ["Sponsor", "Trial", "Condition"],
    highlightEdges: ["RUNS", "TREATS"],
    description: "Filter Phase 3 oncology trials → aggregate sponsors by trial count.",
  },
  g4: {
    title: "Drug Repurposing Signals",
    steps: [
      { type: "node", id: "Condition",    label: "Alzheimer",      note: "start" },
      { type: "edge", label: "TREATS",    dir: "←" },
      { type: "node", id: "Trial",        label: "Alz trials",     note: "" },
      { type: "edge", label: "USES",      dir: "→" },
      { type: "node", id: "Intervention", label: "shared drugs",   note: "result" },
      { type: "edge", label: "USES",      dir: "←" },
      { type: "node", id: "Trial",        label: "Park trials",    note: "" },
      { type: "edge", label: "TREATS",    dir: "→" },
      { type: "node", id: "Condition",    label: "Parkinson",      note: "start" },
    ],
    highlight: ["Condition", "Trial", "Intervention"],
    highlightEdges: ["TREATS", "USES"],
    description: "Find drugs used in both Alzheimer and Parkinson trials — repurposing candidates bridging two CNS conditions.",
  },
  g5: {
    title: "Termination Risk Analysis",
    steps: [
      { type: "node", id: "Condition",  label: "all conditions", note: "result" },
      { type: "edge", label: "TREATS",  dir: "←" },
      { type: "node", id: "Trial",      label: "all trials",     note: "aggregate" },
    ],
    highlight: ["Condition", "Trial"],
    highlightEdges: ["TREATS"],
    description: "For each condition (≥100 trials), compute terminated ÷ total — surfaces high-risk therapeutic areas.",
  },
};

// ── Traversal path diagram — actual bubbles + arrows ────────────────────────
function PathDiagram({ steps }) {
  const nodeSteps = steps.filter(s => s.type === "node");
  const edgeSteps = steps.filter(s => s.type === "edge");
  if (nodeSteps.length === 0) return null;

  const count = nodeSteps.length;
  const nodeR = 44;
  const gapBetween = 60;             // px gap between circle edges
  const centerStep = nodeR * 2 + gapBetween;
  const totalW = nodeR + (count - 1) * centerStep + nodeR;
  const W = totalW + 20;             // 10px padding each side
  const H = 130;
  const offsetX = 10 + nodeR;

  const positions = nodeSteps.map((s, i) => ({
    ...s,
    cx: offsetX + i * centerStep,
    cy: H / 2,
  }));

  const connections = edgeSteps.slice(0, count - 1).map((e, i) => ({
    edge: e,
    from: positions[i],
    to: positions[i + 1],
  }));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="gv-path-svg"
      role="img" aria-label="Query traversal path">
      <defs>
        <marker id="pd-arrow" viewBox="0 0 10 7" refX="9" refY="3.5"
          markerWidth="7" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 0 L 10 3.5 L 0 7 z" fill="#7dd3fc" />
        </marker>
      </defs>

      {/* Edge lines + labels */}
      {connections.map((conn, i) => {
        const x1 = conn.from.cx + nodeR + 2;
        const x2 = conn.to.cx - nodeR - 3;
        const y = H / 2;
        const mx = (x1 + x2) / 2;
        return (
          <g key={i}>
            <line x1={x1} y1={y} x2={x2} y2={y}
              stroke="#38bdf8" strokeWidth="1.5"
              markerEnd="url(#pd-arrow)" />
            <text x={mx} y={y - 9} textAnchor="middle"
              fontSize="8" fontWeight="700" fill="#7dd3fc"
              letterSpacing="0.04">
              {conn.edge.dir} {conn.edge.label}
            </text>
          </g>
        );
      })}

      {/* Node bubbles */}
      {positions.map((n, i) => {
        const color = NODE_MAP[n.id]?.color || "#94a3b8";
        const isBoundary = n.note === "start" || n.note === "result";
        return (
          <g key={i}>
            {isBoundary && (
              <circle cx={n.cx} cy={n.cy} r={nodeR + 5}
                fill="none" stroke={color} strokeWidth="1.5"
                opacity="0.3" strokeDasharray="4 3" />
            )}
            <circle cx={n.cx} cy={n.cy} r={nodeR}
              fill={color + "22"}
              stroke={color}
              strokeWidth={isBoundary ? 2.5 : 1.5} />
            <text x={n.cx} y={n.cy - 10} textAnchor="middle"
              fontSize="8" fontWeight="700" fill={color}
              letterSpacing="0.05">
              {n.id}
            </text>
            <text x={n.cx} y={n.cy + 6} textAnchor="middle"
              fontSize="10" fontWeight="600" fill="#e2e8f0">
              {n.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Main component ───────────────────────────────────────────────────────────
export default function GraphViz({ queryId }) {
  const path = QUERY_PATHS[queryId] || null;
  const highlightSet = useMemo(() => new Set(path?.highlight || []), [path]);
  const highlightEdgeSet = useMemo(() => new Set(path?.highlightEdges || []), [path]);

  return (
    <div className="graph-viz-wrap">
      {/* SVG Schema Diagram */}
      <svg viewBox="0 0 580 250" className="graph-viz-svg" role="img"
        aria-label="Knowledge Graph schema: Sponsor, Trial, Condition, Intervention, Country">
        <defs>
          <marker id="gv-arrow" viewBox="0 0 10 7" refX="10" refY="3.5"
            markerWidth="8" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 3.5 L 0 7 z" fill="#475569" />
          </marker>
          <marker id="gv-arrow-lit" viewBox="0 0 10 7" refX="10" refY="3.5"
            markerWidth="8" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 3.5 L 0 7 z" fill="#7dd3fc" />
          </marker>
        </defs>

        {/* Edges */}
        {EDGES.map(e => {
          const from = NODE_MAP[e.from];
          const to = NODE_MAP[e.to];
          const lit = path ? highlightEdgeSet.has(e.label) : false;
          const dim = path ? !lit : false;
          const dx = to.x - from.x, dy = to.y - from.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const ux = dx / dist, uy = dy / dist;
          const x1 = from.x + ux * (from.r + 2);
          const y1 = from.y + uy * (from.r + 2);
          const x2 = to.x - ux * (to.r + 4);
          const y2 = to.y - uy * (to.r + 4);
          const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;

          return (
            <g key={e.label} opacity={dim ? 0.15 : 1}>
              <line x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={lit ? "#7dd3fc" : "#475569"}
                strokeWidth={lit ? 2.5 : 1.5}
                markerEnd={lit ? "url(#gv-arrow-lit)" : "url(#gv-arrow)"}
                className={lit ? "gv-edge-pulse" : ""} />
              <text x={mx} y={my - 7} textAnchor="middle"
                className="gv-edge-label" fill={lit ? "#7dd3fc" : "#64748b"}>
                {e.label}
              </text>
              <text x={mx} y={my + 7} textAnchor="middle"
                className="gv-edge-count" fill={lit ? "#7dd3fc" : "#475569"}>
                {e.count}
              </text>
            </g>
          );
        })}

        {/* Nodes */}
        {NODES.map(n => {
          const lit = path ? highlightSet.has(n.id) : false;
          const dim = path ? !lit : false;
          return (
            <g key={n.id} opacity={dim ? 0.18 : 1}>
              {lit && (
                <circle cx={n.x} cy={n.y} r={n.r + 7}
                  fill="none" stroke={n.color} strokeWidth="2"
                  opacity="0.35" className="gv-node-glow" />
              )}
              <circle cx={n.x} cy={n.y} r={n.r}
                fill={dim ? n.color + "40" : n.color + (lit ? "ee" : "cc")}
                stroke={lit ? "#fff" : n.color} strokeWidth={lit ? 1.5 : 1} />
              <text x={n.x} y={n.y - 5} textAnchor="middle"
                className="gv-node-label" fill="#fff" fontWeight="600">
                {n.label}
              </text>
              <text x={n.x} y={n.y + 11} textAnchor="middle"
                className="gv-node-count" fill="rgba(255,255,255,0.7)">
                {n.count}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Query traversal path — step-by-step explainer */}
      {path ? (
        <div className="qpe-wrap">
          <div className="qpe-header">
            <span className="qpe-title">{path.title}</span>
            <span className="qpe-desc">{path.description}</span>
          </div>
          <PathDiagram steps={path.steps} />
        </div>
      ) : (
        <div className="qpe-idle-hint">
          Run a graph query above to see how it traverses the knowledge graph
        </div>
      )}

      {/* Legend */}
      <div className="graph-viz-legend">
        <span className="gvl-dot" style={{ background: "#38bdf8" }} /> Trial
        <span className="gvl-dot" style={{ background: "#818cf8" }} /> Sponsor
        <span className="gvl-dot" style={{ background: "#34d399" }} /> Condition
        <span className="gvl-dot" style={{ background: "#fbbf24" }} /> Intervention
        <span className="gvl-dot" style={{ background: "#f472b6" }} /> Country
      </div>
    </div>
  );
}
