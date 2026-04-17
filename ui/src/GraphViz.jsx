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
const CX = VW / 2, CY = VH / 2;  // center of SVG

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

// Build instances with MIRROR layout.
// The middle step of the path goes to SVG center.  Steps fan out symmetrically
// left (earlier steps) and right (later steps).  Unused types stay at their
// schema position and grey out.  Y gets a gentle zigzag so it's not a flat line.
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
  const N = steps.length;
  const mid = Math.floor(N / 2);      // pivot index (center of mirror)
  const hSpacing = N <= 2 ? 120 : N <= 3 ? 100 : 80;
  const yAmp = 25;                      // gentle zigzag amplitude

  // Compute target x,y for each step index
  const stepPos = steps.map((s, i) => {
    const offset = i - mid;             // negative = left, positive = right, 0 = center
    const x = Math.round(CX + offset * hSpacing);
    const y = Math.round(CY + (i % 2 === 0 ? -yAmp : yAmp) * (N > 2 ? 1 : 0));
    return { ...s, stepIdx: i, x, y };
  });

  // Group by type
  const occ = {};
  stepPos.forEach(sp => {
    (occ[sp.id] ??= []).push(sp);
  });

  // For unused nodes: find their connected active neighbour and compute a
  // target position offset from that neighbour (so they "follow" their edge).
  // Schema offsets: vector from neighbour → this node in the schema layout.
  const activeFirstPos = {}; // typeId → {x, y} of first active instance
  const out = [];
  NODES.forEach(n => {
    const hits = occ[n.id];
    if (hits) {
      activeFirstPos[n.id] = { x: hits[0].x, y: hits[0].y };
    }
  });

  NODES.forEach(n => {
    const hits = occ[n.id];
    if (!hits) {
      // Find the connected active node via EDGES
      let neighbour = null;
      for (const e of EDGES) {
        if (e.from === n.id && activeFirstPos[e.to]) { neighbour = e.to; break; }
        if (e.to === n.id && activeFirstPos[e.from]) { neighbour = e.from; break; }
      }
      let tx = n.x, ty = n.y;
      if (neighbour) {
        const nb = NODE_MAP[neighbour];
        const dx = n.x - nb.x, dy = n.y - nb.y;  // schema offset
        const ap = activeFirstPos[neighbour];
        tx = ap.x + dx;
        ty = ap.y + dy;
      }
      out.push({
        key: n.id, typeId: n.id,
        homeX: n.x, homeY: n.y,
        targetX: tx, targetY: ty,
        r: n.r, color: n.color,
        state: "unused", step: null, note: null,
        pathLabel: null, isSplit: false,
      });
      return;
    }
    const split = hits.length > 1;
    hits.forEach((h, j) => {
      out.push({
        key: j === 0 ? n.id : `${n.id}-${j}`,
        typeId: n.id,
        homeX: n.x, homeY: n.y,
        targetX: h.x, targetY: h.y,
        r: n.r, color: n.color,
        state: "active", step: h.stepIdx + 1, note: h.note,
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

  // Build a position lookup for edge drawing — maps each instance key to its
  // current (target or home) position
  const instPos = useMemo(() => {
    const m = {};
    instances.forEach(inst => {
      m[inst.key] = {
        homeX: inst.homeX, homeY: inst.homeY,
        targetX: inst.targetX, targetY: inst.targetY,
        r: inst.r,
      };
    });
    return m;
  }, [instances]);

  // Build path-step edge pairs: consecutive node steps with the edge between them
  const pathEdges = useMemo(() => {
    if (!path) return [];
    const nodeSteps = path.steps.filter(s => s.type === "node");
    const edgeSteps = path.steps.filter(s => s.type === "edge");
    const pairs = [];
    // Map each step index → the instance key
    const typeCounter = {};
    const stepKeys = nodeSteps.map(s => {
      const c = (typeCounter[s.id] = (typeCounter[s.id] || 0));
      typeCounter[s.id]++;
      return c === 0 ? s.id : `${s.id}-${c}`;
    });
    for (let i = 0; i < nodeSteps.length - 1; i++) {
      pairs.push({
        fromKey: stepKeys[i], toKey: stepKeys[i + 1],
        edge: edgeSteps[i],
      });
    }
    return pairs;
  }, [path]);

  // Edges from unused nodes to their active neighbors (dim, follow the move)
  const unusedEdges = useMemo(() => {
    if (!path) return [];
    const out = [];
    instances.forEach(inst => {
      if (inst.state !== "unused") return;
      for (const e of EDGES) {
        const nbId = e.from === inst.typeId ? e.to
                   : e.to === inst.typeId   ? e.from
                   : null;
        if (!nbId || !instPos[nbId]) continue;
        out.push({
          unusedKey: inst.key, activeKey: nbId, label: e.label,
        });
      }
    });
    return out;
  }, [path, instances, instPos]);

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

        {/* ── Schema edges — fade out when query active ── */}
        <g style={{ opacity: active ? 0.15 : 1, transition: "opacity 0.4s" }}>
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

        {/* ── Path edges — draw between actual moved instance positions ── */}
        {pathEdges.map((pe, i) => {
          const fp = instPos[pe.fromKey], tp = instPos[pe.toKey];
          if (!fp || !tp) return null;
          const fx = moved ? fp.targetX : fp.homeX;
          const fy = moved ? fp.targetY : fp.homeY;
          const tx = moved ? tp.targetX : tp.homeX;
          const ty = moved ? tp.targetY : tp.homeY;
          const dx = tx - fx, dy = ty - fy;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const ux = dx / dist, uy = dy / dist;
          const x1 = fx + ux * (fp.r + 3), y1 = fy + uy * (fp.r + 3);
          const x2 = tx - ux * (tp.r + 5), y2 = ty - uy * (tp.r + 5);
          const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
          return (
            <g key={`pe-${i}`}
              style={{ opacity: moved ? 1 : 0, transition: "opacity 0.25s 0.5s" }}>
              <line x1={x1} y1={y1} x2={x2} y2={y2}
                stroke="#38bdf8" strokeWidth="2" markerEnd="url(#gv-arrow-hi)"
                className="gv-edge-pulse" />
              <text x={mx} y={my - 10} textAnchor="middle"
                fontSize="8" fontWeight="700" fill="#7dd3fc" letterSpacing="0.04">
                {pe.edge?.dir} {pe.edge?.label}
              </text>
            </g>
          );
        })}

        {/* ── Dim edges connecting unused nodes to their active neighbors ── */}
        {unusedEdges.map((ue, i) => {
          const up = instPos[ue.unusedKey], ap = instPos[ue.activeKey];
          if (!up || !ap) return null;
          const ux1 = moved ? up.targetX : up.homeX;
          const uy1 = moved ? up.targetY : up.homeY;
          const ax1 = moved ? ap.targetX : ap.homeX;
          const ay1 = moved ? ap.targetY : ap.homeY;
          const dx = ax1 - ux1, dy = ay1 - uy1;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const nx = dx / dist, ny = dy / dist;
          const x1 = ux1 + nx * (up.r + 2), y1 = uy1 + ny * (up.r + 2);
          const x2 = ax1 - nx * (ap.r + 4), y2 = ay1 - ny * (ap.r + 4);
          return (
            <line key={`ue-${i}`} x1={x1} y1={y1} x2={x2} y2={y2}
              stroke="#334155" strokeWidth="1" markerEnd="url(#gv-arrow-dim)"
              style={{ opacity: moved ? 0.4 : 0, transition: "opacity 0.3s 0.5s" }} />
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