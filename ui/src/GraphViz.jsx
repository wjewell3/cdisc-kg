/**
 * GraphViz — unified SVG that transitions between schema and traversal views.
 *
 * Idle:  5 proportional bubbles at schema positions with relationship arrows.
 * Query: the same bubbles animate to a horizontal traversal path.
 *        The Condition/Trial bubbles "split" — same color/size appears twice.
 *        Unused types (Sponsor, Country) fade to near-invisible.
 */
import { useState, useEffect, useMemo } from "react";

// ── Schema layout — radii √-proportional to node counts ──────────────────────
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

const VW = 590, VH = 278;
// Per-type split offsets when a type appears 2x.
// Trial: spread wide horizontally (it's the hub, edges flow left↔right)
// Condition: spread vertically (stacked at top-right, room above/below)
// Intervention: spread vertically
// Sponsor/Country: diagonal
const SPLIT_BY_TYPE = {
  Trial:        [[-50, 0],  [50, 0]],
  Condition:    [[0, -24],  [0, 24]],
  Intervention: [[0, -28],  [0, 28]],
  Sponsor:      [[-18, -14],[18, 14]],
  Country:      [[-12, -10],[12, 10]],
};

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
    description: "Map Pfizer's portfolio → find conditions 1 hop away where Pfizer has zero trials.",
  },
  g3: {
    title: "Sponsor Aggregation",
    steps: [
      { type: "node", id: "Sponsor",   label: "all sponsors",        note: "result" },
      { type: "edge", label: "RUNS",   dir: "→" },
      { type: "node", id: "Trial",     label: "Phase 3 trials",      note: "" },
      { type: "edge", label: "TREATS", dir: "→" },
      { type: "node", id: "Condition", label: "oncology conditions", note: "" },
    ],
    description: "Filter Phase 3 oncology trials → aggregate sponsors by trial count.",
  },
  g4: {
    title: "Drug Repurposing Signals",
    steps: [
      { type: "node", id: "Condition",    label: "Alzheimer",    note: "start" },
      { type: "edge", label: "TREATS",    dir: "←" },
      { type: "node", id: "Trial",        label: "Alz trials",   note: "" },
      { type: "edge", label: "USES",      dir: "→" },
      { type: "node", id: "Intervention", label: "shared drugs", note: "result" },
      { type: "edge", label: "USES",      dir: "←" },
      { type: "node", id: "Trial",        label: "Park trials",  note: "" },
      { type: "edge", label: "TREATS",    dir: "→" },
      { type: "node", id: "Condition",    label: "Parkinson",    note: "start" },
    ],
    description: "Find drugs used in both Alzheimer and Parkinson trials — repurposing candidates bridging two CNS conditions.",
  },
  g5: {
    title: "Termination Risk Analysis",
    steps: [
      { type: "node", id: "Condition", label: "all conditions", note: "result" },
      { type: "edge", label: "TREATS", dir: "←" },
      { type: "node", id: "Trial",     label: "all trials",     note: "" },
    ],
    description: "For each condition (≥100 trials), compute terminated ÷ total — surfaces high-risk therapeutic areas.",
  },
};

// Build instances: one per schema type, but active types that appear 2x in the
// path get a clone that starts overlapping and splits apart.  Unused types stay
// at their schema position and grey out.  Active types stay at schema pos (or
// offset slightly if split).  The graph structure is always visible.
function buildInstances(path) {
  if (!path) {
    return NODES.map(n => ({
      key: n.id, typeId: n.id,
      homeX: n.x, homeY: n.y,
      targetX: n.x, targetY: n.y,
      r: n.r, color: n.color,
      state: "schema", step: null, note: null,
      pathLabel: null, isSplit: false,
    }));
  }

  const steps = path.steps.filter(s => s.type === "node");
  const occ = {};
  steps.forEach((s, idx) => {
    (occ[s.id] ??= []).push({ idx, label: s.label, note: s.note });
  });

  const out = [];
  NODES.forEach(n => {
    const hits = occ[n.id];
    if (!hits) {
      out.push({
        key: n.id, typeId: n.id,
        homeX: n.x, homeY: n.y,
        targetX: n.x, targetY: n.y,
        r: n.r, color: n.color,
        state: "unused", step: null, note: null,
        pathLabel: null, isSplit: false,
      });
      return;
    }
    const split = hits.length > 1;
    const offsets = SPLIT_BY_TYPE[n.id] || [[0, 0], [0, 0]];
    hits.forEach((h, j) => {
      const [dx, dy] = split ? (offsets[j] || [0, 0]) : [0, 0];
      out.push({
        key: j === 0 ? n.id : `${n.id}-${j}`,
        typeId: n.id,
        homeX: n.x, homeY: n.y,
        targetX: n.x + dx, targetY: n.y + dy,
        r: n.r, color: n.color,
        state: "active", step: h.idx + 1, note: h.note,
        pathLabel: h.label, isSplit: split,
      });
    });
  });
  return out;
}

// ── Main component ────────────────────────────────────────────────────────────
export default function GraphViz({ queryId }) {
  const path = QUERY_PATHS[queryId] ?? null;
  const active = !!path;

  // Which edge labels does this query traverse?
  const activeEdges = useMemo(() => {
    if (!path) return new Set();
    return new Set(path.steps.filter(s => s.type === "edge").map(s => s.label));
  }, [path]);

  const instances = useMemo(() => buildInstances(path), [path]);

  // Two-frame delay so clones mount at home pos → then CSS-transition to target
  const [spread, setSpread] = useState(false);
  useEffect(() => {
    if (!queryId) { setSpread(false); return; }
    setSpread(false);
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => setSpread(true));
    });
    return () => cancelAnimationFrame(raf);
  }, [queryId]);

  const moved = active && spread;

  return (
    <div className="graph-viz-wrap">
      <svg viewBox={`0 0 ${VW} ${VH}`} className="graph-viz-svg" role="img"
        aria-label="Knowledge Graph">
        <defs>
          <marker id="gv-arrow" viewBox="0 0 10 7" refX="10" refY="3.5"
            markerWidth="8" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 3.5 L 0 7 z" fill="#475569" />
          </marker>
          <marker id="gv-arrow-hi" viewBox="0 0 10 7" refX="10" refY="3.5"
            markerWidth="8" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 3.5 L 0 7 z" fill="#38bdf8" />
          </marker>
          <marker id="gv-arrow-dim" viewBox="0 0 10 7" refX="10" refY="3.5"
            markerWidth="8" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 3.5 L 0 7 z" fill="#334155" />
          </marker>
        </defs>

        {/* ── Edges — always visible; highlighted or dimmed based on traversal ── */}
        {EDGES.map(e => {
          const from = NODE_MAP[e.from], to = NODE_MAP[e.to];
          const dx = to.x - from.x, dy = to.y - from.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const ux = dx / dist, uy = dy / dist;
          const x1 = from.x + ux * (from.r + 2), y1 = from.y + uy * (from.r + 2);
          const x2 = to.x - ux * (to.r + 4),     y2 = to.y - uy * (to.r + 4);
          const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;

          const hi  = active && activeEdges.has(e.label);
          const dim = active && !hi;

          const edgeStroke = hi ? "#38bdf8" : dim ? "#334155" : "#475569";
          const labelFill  = hi ? "#7dd3fc" : dim ? "#334155" : "#64748b";
          const countFill  = hi ? "#38bdf8" : dim ? "#334155" : "#475569";
          const marker = hi ? "url(#gv-arrow-hi)" : dim ? "url(#gv-arrow-dim)" : "url(#gv-arrow)";
          const sw = hi ? 2 : 1.5;

          return (
            <g key={e.label}>
              <line x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={edgeStroke} strokeWidth={sw} markerEnd={marker}
                style={{ transition: "stroke 0.4s" }} />
              <text x={mx} y={my - 7} textAnchor="middle"
                fontSize="9" fontWeight="600" fill={labelFill} letterSpacing="0.04"
                style={{ transition: "fill 0.4s" }}>{e.label}</text>
              <text x={mx} y={my + 7} textAnchor="middle"
                fontSize="8" fill={countFill}
                style={{ transition: "fill 0.4s" }}>{e.count}</text>
            </g>
          );
        })}

        {/* ── Nodes — same visual as schema; unused grey out, active get badges ── */}
        {instances.map(inst => {
          const x = moved ? inst.targetX : inst.homeX;
          const y = moved ? inst.targetY : inst.homeY;
          const { r, color } = inst;
          const def = NODE_MAP[inst.typeId];

          const isUnused = inst.state === "unused";
          const isActive = inst.state === "active";
          const isResult = inst.note === "result";

          // Exact same colors as schema idle — except unused goes grey
          const fill   = isUnused ? "#1e293b" : color + "cc";
          const stroke = isUnused ? "#334155" : color;
          const opacity = isUnused ? 0.3 : 1;

          // Text fills — same as schema idle
          const mainFill  = isUnused ? "#475569" : "#fff";
          const subFill   = isUnused ? "#334155" : "rgba(255,255,255,0.7)";
          const belowFill = isUnused ? "#334155" : color;

          const big = r >= 28;

          return (
            <g key={inst.key} style={{
              transform: `translate(${x}px, ${y}px)`,
              transition: "transform 0.6s ease, opacity 0.4s",
              opacity,
            }}>
              {/* Glow ring for result nodes */}
              {isResult && moved && (
                <circle r={r + 6} fill="none"
                  stroke={color} strokeWidth="1.5"
                  opacity="0.5" className="gv-node-glow" />
              )}

              <circle r={r} fill={fill} stroke={stroke} strokeWidth="1"
                style={{ transition: "fill 0.4s, stroke 0.4s" }} />

              {/* Text — identical layout to schema idle */}
              {big ? (
                <>
                  <text y={-4} textAnchor="middle"
                    fontSize={inst.typeId === "Intervention" ? "9" : "11"}
                    fontWeight="600" fill={mainFill}
                    style={{ transition: "fill 0.4s" }}>
                    {def.label}
                  </text>
                  <text y={12} textAnchor="middle"
                    fontSize="10" fill={subFill}
                    style={{ transition: "fill 0.4s" }}>
                    {def.count}
                  </text>
                </>
              ) : r >= 12 ? (
                <>
                  <text y={4} textAnchor="middle"
                    fontSize="8" fontWeight="700" fill={mainFill}
                    style={{ transition: "fill 0.4s" }}>
                    {def.count}
                  </text>
                  <text y={r + 13} textAnchor="middle"
                    fontSize="10" fontWeight="600" fill={belowFill}
                    style={{ transition: "fill 0.4s" }}>
                    {def.label}
                  </text>
                </>
              ) : (
                <text y={r + 12} textAnchor="middle"
                  fontSize="9" fontWeight="600" fill={belowFill}
                  style={{ transition: "fill 0.4s" }}>
                  {def.label}
                </text>
              )}

              {/* Step badge — shows traversal order */}
              {isActive && moved && inst.step != null && (
                <g>
                  <circle cx={r * 0.7} cy={-r * 0.7} r={8}
                    fill="#0f172a" stroke={color} strokeWidth="1.5" />
                  <text x={r * 0.7} y={-r * 0.7 + 4} textAnchor="middle"
                    fontSize="9" fontWeight="700" fill={color}>
                    {inst.step}
                  </text>
                </g>
              )}

              {/* Split annotation — tiny path label to distinguish duplicates */}
              {inst.isSplit && moved && inst.pathLabel && (
                <text y={big ? r + 14 : r + (r >= 12 ? 26 : 24)} textAnchor="middle"
                  fontSize="8" fill={color} opacity="0.8">
                  {inst.pathLabel}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Description */}
      {path ? (
        <div className="qpe-wrap"
          style={{ opacity: moved ? 1 : 0, transition: "opacity 0.3s 0.6s" }}>
          <span className="qpe-title">{path.title}</span>
          <span className="qpe-desc">{path.description}</span>
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