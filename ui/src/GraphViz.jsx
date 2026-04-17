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

// ── Organic path layout — alternating y for natural feel ──────────────────────
function computePathLayout(nodeSteps) {
  const N = nodeSteps.length;
  if (N === 0) return [];
  const scale = N <= 2 ? 0.85 : N <= 3 ? 0.75 : 0.65;
  const xPad = 80;
  const centerY = VH / 2;
  const yAmp = N <= 2 ? 20 : N <= 3 ? 30 : 38;

  return nodeSteps.map((s, i) => {
    const def = NODE_MAP[s.id];
    const r = Math.round((def?.r ?? 24) * scale);
    const x = N === 1 ? VW / 2
            : Math.round(xPad + i * (VW - 2 * xPad) / (N - 1));
    const y = Math.round(centerY + (i % 2 === 0 ? -yAmp : yAmp));
    return { ...s, r, color: def?.color ?? "#94a3b8", pathX: x, pathY: y };
  });
}

// Build one stable primary instance per schema type (key = typeId, so
// React reuses the same DOM node) + clone instances for types that
// appear more than once in the path.  Clones mount overlapping the
// primary at the schema position, then CSS-transition apart → visible split.
function buildInstances(path, pathLayout) {
  const typeOcc = {};
  pathLayout.forEach(pn => {
    if (!typeOcc[pn.id]) typeOcc[pn.id] = [];
    typeOcc[pn.id].push(pn);
  });

  const instances = [];

  // Primary: one per schema type — always in the DOM
  NODES.forEach(n => {
    const first = typeOcc[n.id]?.[0] ?? null;
    const inPath = !!first;
    instances.push({
      key: n.id,        // stable key → React reuses the DOM element
      typeId: n.id,
      homeX: n.x, homeY: n.y, homeR: n.r,
      pathX: first?.pathX ?? n.x,
      pathY: first?.pathY ?? n.y,
      pathR: first?.r ?? n.r,
      color: n.color,
      label: n.label, count: n.count,
      pathLabel: first?.label ?? "",
      note: inPath ? (first.note || "mid") : (path ? "unused" : "schema"),
      clone: false,
    });
  });

  // Clones: 2nd+ occurrence of a type in the path
  Object.entries(typeOcc).forEach(([typeId, occs]) => {
    const def = NODE_MAP[typeId];
    for (let j = 1; j < occs.length; j++) {
      const pn = occs[j];
      instances.push({
        key: `${typeId}-${j}`,
        typeId,
        homeX: def.x, homeY: def.y, homeR: def.r,
        pathX: pn.pathX, pathY: pn.pathY, pathR: pn.r,
        color: def.color,
        label: def.label, count: def.count,
        pathLabel: pn.label,
        note: pn.note || "mid",
        clone: true,
      });
    }
  });

  return instances;
}

// ── Main component ────────────────────────────────────────────────────────────
export default function GraphViz({ queryId }) {
  const path = QUERY_PATHS[queryId] ?? null;
  const active = !!path;

  const edgeSteps = useMemo(
    () => (path?.steps ?? []).filter(s => s.type === "edge"),
    [path]
  );
  const pathLayout = useMemo(() => {
    if (!path) return [];
    return computePathLayout(path.steps.filter(s => s.type === "node"));
  }, [path]);
  const instances = useMemo(
    () => buildInstances(path, pathLayout),
    [path, pathLayout]
  );

  // Two-frame delay: mount clones at home position → paint → transition apart
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
          <marker id="pd-arrow" viewBox="0 0 10 7" refX="9" refY="3.5"
            markerWidth="7" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 3.5 L 0 7 z" fill="#7dd3fc" />
          </marker>
        </defs>

        {/* ── Schema relationship arrows — visible when idle ── */}
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

        {/* ── Path traversal arrows — angled between organic positions ── */}
        {pathLayout.length > 1 && pathLayout.slice(0, -1).map((from, i) => {
          const to = pathLayout[i + 1];
          const edge = edgeSteps[i];
          const dx = to.pathX - from.pathX, dy = to.pathY - from.pathY;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const ux = dx / dist, uy = dy / dist;
          const x1 = from.pathX + ux * (from.r + 3);
          const y1 = from.pathY + uy * (from.r + 3);
          const x2 = to.pathX - ux * (to.r + 4);
          const y2 = to.pathY - uy * (to.r + 4);
          const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
          return (
            <g key={`pe-${i}`}
              style={{ opacity: moved ? 1 : 0, transition: "opacity 0.25s 0.5s" }}>
              <line x1={x1} y1={y1} x2={x2} y2={y2}
                stroke="#38bdf8" strokeWidth="1.5" markerEnd="url(#pd-arrow)" />
              <text x={mx} y={my - 10} textAnchor="middle"
                fontSize="8" fontWeight="700" fill="#7dd3fc" letterSpacing="0.04">
                {edge?.dir} {edge?.label}
              </text>
            </g>
          );
        })}

        {/* ── Bubbles: primaries split + rearrange, clones emerge, unused grey ── */}
        {instances.map(inst => {
          const isUnused = inst.note === "unused";
          const isSchema = inst.note === "schema";
          const isResult = inst.note === "result";
          const isStart  = inst.note === "start";
          const grey = active && isUnused;

          const x = moved ? inst.pathX : inst.homeX;
          const y = moved ? inst.pathY : inst.homeY;
          const r = moved ? inst.pathR : inst.homeR;

          // Colors
          const fill = grey    ? "#1e293b"
                     : isSchema ? inst.color + "cc"
                     : isResult ? inst.color + "cc"
                     : isStart  ? inst.color + "55"
                     :            inst.color + "44";
          const stroke = grey    ? "#334155"
                       : isSchema ? inst.color
                       : isResult ? "#fff"
                       : isStart  ? inst.color
                       :            "#475569";
          const sw = isResult ? 2 : 1;
          const opacity = grey ? 0.25 : 1;

          const labelFill = grey    ? "#334155"
                          : isSchema ? "#fff"
                          : isResult ? "#fff"
                          : isStart  ? inst.color
                          :            "#94a3b8";
          const subFill = grey    ? "#334155"
                        : isSchema ? "rgba(255,255,255,0.7)"
                        : isResult ? "#fff"
                        : isStart  ? inst.color
                        :            "#cbd5e1";

          // What text to show
          const showLabel = (moved && !isSchema && !isUnused)
            ? inst.typeId : inst.label;
          const showSub = (moved && !isSchema && !isUnused)
            ? inst.pathLabel : inst.count;

          const big = r >= 26;

          return (
            <g key={inst.key} style={{
              transform: `translate(${x}px, ${y}px)`,
              transition: "transform 0.6s ease, opacity 0.4s",
              opacity,
            }}>
              {isResult && moved && (
                <circle r={r + 6} fill="none"
                  stroke={inst.color} strokeWidth="1.5"
                  opacity="0.4" className="gv-node-glow" />
              )}
              <circle r={r} fill={fill} stroke={stroke} strokeWidth={sw} />

              {big ? (
                <>
                  <text y={-4} textAnchor="middle"
                    fontSize={inst.typeId === "Intervention" ? "9" : "11"}
                    fontWeight="600" fill={labelFill}>
                    {showLabel}
                  </text>
                  <text y={12} textAnchor="middle"
                    fontSize="10" fill={subFill}>
                    {showSub}
                  </text>
                </>
              ) : r >= 12 ? (
                <>
                  <text y={4} textAnchor="middle"
                    fontSize="8" fontWeight="700" fill="rgba(255,255,255,0.9)">
                    {isSchema ? inst.count : ""}
                  </text>
                  <text y={r + 13} textAnchor="middle"
                    fontSize="10" fontWeight="600"
                    fill={grey ? "#334155" : inst.color}>
                    {showLabel}
                  </text>
                  {moved && !isSchema && !isUnused && (
                    <text y={r + 24} textAnchor="middle"
                      fontSize="9" fontWeight="600" fill={subFill}>
                      {showSub}
                    </text>
                  )}
                </>
              ) : (
                <text y={r + 12} textAnchor="middle"
                  fontSize="9" fontWeight="600"
                  fill={grey ? "#334155" : inst.color}>
                  {showLabel}
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


