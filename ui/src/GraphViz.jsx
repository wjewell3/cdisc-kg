/**
 * GraphViz — SVG schema diagram + query traversal path explainer.
 *
 * Default: Clean SVG showing 5 node types and their relationships.
 * On query: Highlights the traversal path with step-by-step flow and counts.
 */
import { } from "react";

// ── Schema layout — fixed positions for clean diagram ────────────────────────
// Radii are sqrt-proportional to node counts (Trial 580k ≈ Intervention 512k >> Condition 129k >> Sponsor 50k >> Country 225)
const NODES = [
  { id: "Sponsor",      label: "Sponsor",      count: "49.9k",  x: 82,  y: 118, color: "#818cf8", r: 16 },
  { id: "Trial",        label: "Trial",         count: "580k",   x: 285, y: 118, color: "#38bdf8", r: 44 },
  { id: "Condition",    label: "Condition",     count: "129k",   x: 500, y: 58,  color: "#34d399", r: 22 },
  { id: "Intervention", label: "Intervention",  count: "512k",   x: 500, y: 168, color: "#fbbf24", r: 41 },
  { id: "Country",      label: "Country",       count: "225",    x: 285, y: 232, color: "#f472b6", r: 8  },
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

// ── Traversal path diagram — main viz when a query is active ─────────────────
// Uses the same node radii as the schema so sizes stay consistent.
function PathDiagram({ steps }) {
  const nodeSteps = steps.filter(s => s.type === "node");
  const edgeSteps = steps.filter(s => s.type === "edge");
  if (nodeSteps.length === 0) return null;

  const count = nodeSteps.length;
  const gap = 52;  // px between circle edges

  // Each node gets its real schema radius
  const positioned = nodeSteps.map((s, i) => ({
    ...s,
    r: NODE_MAP[s.id]?.r ?? 24,
    color: NODE_MAP[s.id]?.color ?? "#94a3b8",
  }));

  // Compute x positions: each center = prev center + prev.r + gap + cur.r
  let cx = 0;
  positioned.forEach((n, i) => {
    if (i === 0) { cx = n.r; }
    else { cx = positioned[i - 1].cx + positioned[i - 1].r + gap + n.r; }
    n.cx = cx;
  });

  const maxR = Math.max(...positioned.map(n => n.r));
  const H = maxR * 2 + 60;  // nodes centered, room for labels above/below
  const cy = H / 2 + 10;
  const W = cx + maxR + 10;

  const connections = edgeSteps.slice(0, count - 1).map((e, i) => ({
    edge: e,
    from: positioned[i],
    to: positioned[i + 1],
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

      {/* Edges */}
      {connections.map((conn, i) => {
        const x1 = conn.from.cx + conn.from.r + 2;
        const x2 = conn.to.cx - conn.to.r - 3;
        const mx = (x1 + x2) / 2;
        return (
          <g key={i}>
            <line x1={x1} y1={cy} x2={x2} y2={cy}
              stroke="#38bdf8" strokeWidth="1.5"
              markerEnd="url(#pd-arrow)" />
            <text x={mx} y={cy - 8} textAnchor="middle"
              fontSize="8" fontWeight="700" fill="#7dd3fc" letterSpacing="0.04">
              {conn.edge.dir} {conn.edge.label}
            </text>
          </g>
        );
      })}

      {/* Nodes */}
      {positioned.map((n, i) => {
        const isResult = n.note === "result";
        const isStart  = n.note === "start";
        // result = fully bright; start = semi-lit; intermediate = dim grey
        const fill   = isResult ? n.color + "cc"
                     : isStart  ? n.color + "55"
                     :            "#1e293b";
        const stroke = isResult ? "#fff"
                     : isStart  ? n.color
                     :            "#475569";
        const sw     = isResult ? 2 : 1.5;
        const labelColor = isResult ? "#fff" : isStart ? n.color : "#94a3b8";
        const small  = n.r < 20;

        return (
          <g key={i}>
            {isResult && (
              <circle cx={n.cx} cy={cy} r={n.r + 7}
                fill="none" stroke={n.color} strokeWidth="1.5"
                opacity="0.4" className="gv-node-glow" />
            )}
            <circle cx={n.cx} cy={cy} r={n.r}
              fill={fill} stroke={stroke} strokeWidth={sw} />
            {/* type label above */}
            <text x={n.cx} y={cy - n.r - 6} textAnchor="middle"
              fontSize="8" fontWeight="700" fill={labelColor}
              letterSpacing="0.05" textDecoration="none">
              {n.id}
            </text>
            {/* instance label inside (large) or below (small) */}
            {small ? (
              <text x={n.cx} y={cy + n.r + 13} textAnchor="middle"
                fontSize="9" fontWeight="600" fill={labelColor}>
                {n.label}
              </text>
            ) : (
              <text x={n.cx} y={cy + 5} textAnchor="middle"
                fontSize="10" fontWeight="600" fill={isResult ? "#fff" : "#cbd5e1"}>
                {n.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ── Main component ───────────────────────────────────────────────────────────
export default function GraphViz({ queryId }) {
  const path = QUERY_PATHS[queryId] || null;

  return (
    <div className="graph-viz-wrap">

      {path ? (
        /* ── Active query: show traversal path as main viz ── */
        <div className="qpe-wrap">
          <div className="qpe-header">
            <span className="qpe-title">{path.title}</span>
            <span className="qpe-desc">{path.description}</span>
          </div>
          <PathDiagram steps={path.steps} />
        </div>
      ) : (
        /* ── Idle: show schema SVG ── */
        <>
          <svg viewBox="0 0 590 278" className="graph-viz-svg" role="img"
            aria-label="Knowledge Graph schema: Sponsor, Trial, Condition, Intervention, Country">
            <defs>
              <marker id="gv-arrow" viewBox="0 0 10 7" refX="10" refY="3.5"
                markerWidth="8" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 3.5 L 0 7 z" fill="#475569" />
              </marker>
            </defs>

            {/* Edges */}
            {EDGES.map(e => {
              const from = NODE_MAP[e.from];
              const to = NODE_MAP[e.to];
              const dx = to.x - from.x, dy = to.y - from.y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              const ux = dx / dist, uy = dy / dist;
              const x1 = from.x + ux * (from.r + 2);
              const y1 = from.y + uy * (from.r + 2);
              const x2 = to.x - ux * (to.r + 4);
              const y2 = to.y - uy * (to.r + 4);
              const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
              return (
                <g key={e.label}>
                  <line x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke="#475569" strokeWidth="1.5"
                    markerEnd="url(#gv-arrow)" />
                  <text x={mx} y={my - 7} textAnchor="middle"
                    className="gv-edge-label" fill="#64748b">{e.label}</text>
                  <text x={mx} y={my + 7} textAnchor="middle"
                    className="gv-edge-count" fill="#475569">{e.count}</text>
                </g>
              );
            })}

            {/* Nodes */}
            {NODES.map(n => {
              const small = n.r < 30;
              return (
                <g key={n.id}>
                  <circle cx={n.x} cy={n.y} r={n.r}
                    fill={n.color + "cc"} stroke={n.color} strokeWidth="1" />
                  {small ? (
                    <>
                      {n.r >= 12 && (
                        <text x={n.x} y={n.y + 4} textAnchor="middle"
                          fontSize="8" fontWeight="700" fill="rgba(255,255,255,0.9)">{n.count}</text>
                      )}
                      <text x={n.x} y={n.y + n.r + 13} textAnchor="middle"
                        fontSize="10" fontWeight="600" fill={n.color}>{n.label}</text>
                      {n.r < 12 && (
                        <text x={n.x} y={n.y + n.r + 24} textAnchor="middle"
                          fontSize="9" fill="rgba(255,255,255,0.55)">{n.count}</text>
                      )}
                    </>
                  ) : (
                    <>
                      <text x={n.x} y={n.y - 5} textAnchor="middle"
                        fontSize={n.id === "Intervention" ? "9" : "11"}
                        fontWeight="600" fill="#fff">{n.label}</text>
                      <text x={n.x} y={n.y + 12} textAnchor="middle"
                        fontSize="10" fill="rgba(255,255,255,0.7)">{n.count}</text>
                    </>
                  )}
                </g>
              );
            })}
          </svg>
          <div className="qpe-idle-hint">
            Run a graph query above to see how it traverses the knowledge graph
          </div>
        </>
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
