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
const PATH_CY = 148;  // vertical center for path layout
const GAP = 50;       // px gap between circle edges in path

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

// Compute horizontal path positions for a set of node steps.
function buildPathNodes(nodeSteps) {
  const nodes = [];
  let cursor = 0;
  for (let i = 0; i < nodeSteps.length; i++) {
    const s = nodeSteps[i];
    const def = NODE_MAP[s.id];
    const r = def?.r ?? 24;
    const color = def?.color ?? "#94a3b8";
    cursor = i === 0 ? r : nodes[i - 1].pathX + nodes[i - 1].r + GAP + r;
    nodes.push({ ...s, r, color, pathX: cursor });
  }
  const totalW = nodes.length
    ? nodes[nodes.length - 1].pathX + nodes[nodes.length - 1].r
    : 0;
  const shift = Math.max(0, (VW - totalW) / 2);
  nodes.forEach(n => { n.pathX += shift; });
  return nodes;
}

// Build the unified instance list.
// Each instance has a "home" position (type's schema pos) and a "path" position.
// When idle: all instances for a type stack at the same schema x,y (look like one bubble).
// When a query runs: instances spread to their path spots; unused types shrink away.
function buildInstances(path) {
  if (!path) {
    // Idle: one instance per schema node type
    return NODES.map(n => ({
      key: n.id,
      typeId: n.id,
      r: n.r,
      color: n.color,
      homeX: n.x, homeY: n.y,
      pathX: n.x, pathY: n.y, // no movement when idle
      label: n.label,
      sublabel: n.count,
      note: "schema",
      used: true,
    }));
  }

  const nodeSteps = path.steps.filter(s => s.type === "node");
  const pathPositioned = buildPathNodes(nodeSteps);
  const usedTypes = new Set(nodeSteps.map(s => s.id));

  // One instance per path step (they start at their type's schema position)
  const instances = pathPositioned.map((pn, i) => {
    const def = NODE_MAP[pn.id];
    return {
      key: `p-${i}`,
      typeId: pn.id,
      r: pn.r,
      color: pn.color,
      homeX: def.x, homeY: def.y,
      pathX: pn.pathX, pathY: PATH_CY,
      label: pn.id,
      sublabel: pn.label,
      note: pn.note,
      used: true,
    };
  });

  // Add greyed-out instances for unused types — stay at schema pos, visible but desaturated
  NODES.forEach(n => {
    if (!usedTypes.has(n.id)) {
      instances.push({
        key: `dim-${n.id}`,
        typeId: n.id,
        r: n.r,
        color: n.color,
        homeX: n.x, homeY: n.y,
        pathX: n.x, pathY: n.y, // stay put
        label: n.label,
        sublabel: n.count,
        note: "unused",
        used: false,
      });
    }
  });

  return instances;
}

// ── Main component ────────────────────────────────────────────────────────────
export default function GraphViz({ queryId }) {
  const path = QUERY_PATHS[queryId] ?? null;

  const edgeSteps = useMemo(
    () => (path?.steps ?? []).filter(s => s.type === "edge"),
    [path]
  );
  const instances = useMemo(() => buildInstances(path), [path]);
  const pathNodes = useMemo(
    () => instances.filter(inst => inst.used && inst.note !== "schema"),
    [instances]
  );

  // Animation: start at home → then transition to path
  const [spread, setSpread] = useState(false);
  useEffect(() => {
    if (!queryId) { setSpread(false); return; }
    setSpread(false);
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => setSpread(true));
    });
    return () => cancelAnimationFrame(raf);
  }, [queryId]);

  const active = !!path;
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
          <marker id="pd-arrow" viewBox="0 0 10 7" refX="9" refY="3.5"
            markerWidth="7" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 3.5 L 0 7 z" fill="#7dd3fc" />
          </marker>
        </defs>

        {/* ── Schema relationship arrows — fade out on query ── */}
        <g style={{ opacity: active ? 0 : 1, transition: "opacity 0.3s" }}>
          {EDGES.map(e => {
            const from = NODE_MAP[e.from], to = NODE_MAP[e.to];
            const dx = to.x - from.x, dy = to.y - from.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const ux = dx / dist, uy = dy / dist;
            const x1 = from.x + ux * (from.r + 2), y1 = from.y + uy * (from.r + 2);
            const x2 = to.x - ux * (to.r + 4),     y2 = to.y - uy * (to.r + 4);
            const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
            return (
              <g key={e.label}>
                <line x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke="#475569" strokeWidth="1.5" markerEnd="url(#gv-arrow)" />
                <text x={mx} y={my - 7} textAnchor="middle"
                  fontSize="9" fontWeight="600" fill="#64748b" letterSpacing="0.04">{e.label}</text>
                <text x={mx} y={my + 7} textAnchor="middle"
                  fontSize="8" fill="#475569">{e.count}</text>
              </g>
            );
          })}
        </g>

        {/* ── Path traversal arrows — appear after spread ── */}
        {pathNodes.length > 1 && pathNodes.slice(0, -1).map((from, i) => {
          const to = pathNodes[i + 1];
          const edge = edgeSteps[i];
          const x1 = from.pathX + from.r + 2;
          const x2 = to.pathX - to.r - 3;
          const mx = (x1 + x2) / 2;
          return (
            <g key={`pe-${i}`}
              style={{ opacity: moved ? 1 : 0, transition: "opacity 0.25s 0.45s" }}>
              <line x1={x1} y1={PATH_CY} x2={x2} y2={PATH_CY}
                stroke="#38bdf8" strokeWidth="1.5" markerEnd="url(#pd-arrow)" />
              <text x={mx} y={PATH_CY - 9} textAnchor="middle"
                fontSize="8" fontWeight="700" fill="#7dd3fc" letterSpacing="0.04">
                {edge?.dir} {edge?.label}
              </text>
            </g>
          );
        })}

        {/* ── THE BUBBLES — one unified set that morphs between layouts ── */}
        {instances.map(inst => {
          const x = moved ? inst.pathX : inst.homeX;
          const y = moved ? inst.pathY : inst.homeY;
          const isUnused = inst.note === "unused";
          const isSchema = inst.note === "schema";
          const isResult = inst.note === "result";
          const isStart  = inst.note === "start";

          // Radius: always keep proportional (unused = greyed out, not shrunk)
          const r = inst.r;

          // When active and unused: grey out; otherwise use type color
          const fill = (active && isUnused) ? "#1e293b"
                     : isSchema             ? inst.color + "cc"
                     : isResult             ? inst.color + "cc"
                     : isStart              ? inst.color + "55"
                     :                        "#1e293b";
          const stroke = (active && isUnused) ? "#334155"
                       : isSchema             ? inst.color
                       : isResult             ? "#fff"
                       : isStart              ? inst.color
                       :                        "#475569";
          const sw = isResult ? 2 : 1;

          // Text colors
          const labelFill = (active && isUnused) ? "#334155"
                          : isSchema             ? "#fff"
                          : isResult             ? "#fff"
                          : isStart              ? inst.color
                          :                        "#94a3b8";
          const subFill = (active && isUnused) ? "#334155"
                        : isSchema             ? "rgba(255,255,255,0.7)"
                        : isResult             ? "#fff"
                        : isStart              ? inst.color
                        :                        "#cbd5e1";

          const big = r >= 28;

          return (
            <g key={inst.key} style={{
              transform: `translate(${x}px, ${y}px)`,
              transition: "transform 0.5s ease, opacity 0.4s",
              opacity: (active && isUnused) ? 0.25 : 1,
            }}>
              {isResult && (
                <circle r={r + 6} fill="none"
                  stroke={inst.color} strokeWidth="1.5"
                  opacity="0.4" className="gv-node-glow" />
              )}
              <circle r={r} fill={fill} stroke={stroke} strokeWidth={sw}
                style={{ transition: "r 0.5s ease" }} />

              {/* Top label: type name for path, label for schema */}
              {big ? (
                <>
                  <text y={isSchema ? -4 : -r - 7} textAnchor="middle"
                    fontSize={isSchema ? (inst.typeId === "Intervention" ? "9" : "11") : "8"}
                    fontWeight={isSchema ? "600" : "700"} fill={labelFill}
                    letterSpacing={isSchema ? "0" : "0.05"}>
                    {inst.label}
                  </text>
                  <text y={isSchema ? 12 : 5} textAnchor="middle"
                    fontSize="10" fontWeight={isSchema ? "400" : "600"} fill={subFill}>
                    {inst.sublabel}
                  </text>
                </>
              ) : (
                <>
                  {r >= 12 && (
                    <text y={4} textAnchor="middle"
                      fontSize="8" fontWeight="700" fill="rgba(255,255,255,0.9)">
                      {isSchema ? inst.sublabel : ""}
                    </text>
                  )}
                  {/* Label below circle */}
                  <text y={r + 13} textAnchor="middle"
                    fontSize={isSchema ? "10" : "8"} fontWeight={isSchema ? "600" : "700"}
                    fill={isSchema ? inst.color : labelFill}
                    letterSpacing={isSchema ? "0" : "0.05"}>
                    {inst.label}
                  </text>
                  {!isSchema && (
                    <text y={r + 24} textAnchor="middle"
                      fontSize="9" fontWeight="600" fill={subFill}>
                      {inst.sublabel}
                    </text>
                  )}
                </>
              )}
            </g>
          );
        })}
      </svg>

      {/* Description row */}
      {path ? (
        <div className="qpe-wrap"
          style={{ opacity: moved ? 1 : 0, transition: "opacity 0.3s 0.5s" }}>
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


