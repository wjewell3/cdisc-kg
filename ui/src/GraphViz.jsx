/**
 * GraphViz — Force-directed knowledge graph visualization.
 *
 * Default state: KG schema universe (5 node types, relationship edges).
 * After a graph query: result nodes shown as interactive force graph.
 * Table/Graph toggle is controlled by parent via `viewMode` prop.
 */
import { useRef, useCallback, useMemo, useState, useEffect } from "react";
import ForceGraph2D from "react-force-graph-2d";

// ── KG Schema (always shown as idle/background state) ────────────────────────
const SCHEMA_DATA = {
  nodes: [
    { id: "Sponsor",      label: "Sponsor\n49,929",      color: "#6366f1", size: 16, nodeType: "schema" },
    { id: "Trial",        label: "Trial\n580,489",        color: "#0ea5e9", size: 28, nodeType: "schema" },
    { id: "Condition",    label: "Condition\n129,085",    color: "#10b981", size: 20, nodeType: "schema" },
    { id: "Intervention", label: "Intervention\n512,289", color: "#f59e0b", size: 22, nodeType: "schema" },
    { id: "Country",      label: "Country\n225",          color: "#ec4899", size: 10, nodeType: "schema" },
  ],
  links: [
    { source: "Sponsor",      target: "Trial",        label: "RUNS",         value: 8 },
    { source: "Trial",        target: "Condition",    label: "TREATS",       value: 10 },
    { source: "Trial",        target: "Intervention", label: "USES",         value: 9 },
    { source: "Trial",        target: "Country",      label: "CONDUCTED_IN", value: 5 },
  ],
};

// Node type → color mapping for result nodes
const TYPE_COLORS = {
  condition:    "#10b981",
  sponsor:      "#6366f1",
  intervention: "#f59e0b",
  country:      "#ec4899",
  hub:          "#0ea5e9",
  metric:       "#94a3b8",
};

// ── Per-preset result → graph shape builders ─────────────────────────────────
function buildGraphData(queryId, columns, rows) {
  if (!rows || rows.length === 0) return null;

  switch (queryId) {
    case "g1": {
      // columns: condition, shared_interventions
      // Hub-spoke: Breast Cancer → adjacent conditions, edge weight = shared interventions
      const maxVal = Math.max(...rows.map(r => r.shared_interventions || 1));
      return {
        nodes: [
          { id: "Breast Cancer", label: "Breast Cancer", color: TYPE_COLORS.hub, size: 20, nodeType: "hub" },
          ...rows.map(r => ({
            id: r.condition,
            label: r.condition,
            color: TYPE_COLORS.condition,
            size: 6 + 14 * (r.shared_interventions / maxVal),
            val: r.shared_interventions,
            nodeType: "condition",
            detail: `${r.shared_interventions} shared interventions`,
          })),
        ],
        links: rows.map(r => ({
          source: "Breast Cancer",
          target: r.condition,
          label: `${r.shared_interventions}`,
          value: r.shared_interventions,
        })),
      };
    }

    case "g2": {
      // columns: expansion_target, adjacency_strength, via_conditions
      // Hub-spoke: Pfizer → gap conditions, edge weight = adjacency strength
      const maxVal = Math.max(...rows.map(r => r.adjacency_strength || 1));
      return {
        nodes: [
          { id: "Pfizer", label: "Pfizer", color: TYPE_COLORS.sponsor, size: 22, nodeType: "sponsor" },
          ...rows.map(r => ({
            id: r.expansion_target,
            label: r.expansion_target,
            color: TYPE_COLORS.condition,
            size: 6 + 14 * (r.adjacency_strength / maxVal),
            val: r.adjacency_strength,
            nodeType: "condition",
            detail: `strength ${r.adjacency_strength}`,
            via: Array.isArray(r.via_conditions) ? r.via_conditions.join(", ") : String(r.via_conditions ?? ""),
          })),
        ],
        links: rows.map(r => ({
          source: "Pfizer",
          target: r.expansion_target,
          label: `${r.adjacency_strength}`,
          value: r.adjacency_strength,
        })),
      };
    }

    case "g3": {
      // columns: sponsor, trials
      // Hub-spoke: Phase 3 Oncology → sponsors, edge weight = trial count
      const maxVal = Math.max(...rows.map(r => r.trials || 1));
      return {
        nodes: [
          { id: "__hub__", label: "Phase 3\nOncology", color: TYPE_COLORS.hub, size: 18, nodeType: "hub" },
          ...rows.map(r => ({
            id: r.sponsor,
            label: r.sponsor,
            color: TYPE_COLORS.sponsor,
            size: 6 + 14 * (r.trials / maxVal),
            val: r.trials,
            nodeType: "sponsor",
            detail: `${r.trials} trials`,
          })),
        ],
        links: rows.map(r => ({
          source: "__hub__",
          target: r.sponsor,
          label: `${r.trials}`,
          value: r.trials,
        })),
      };
    }

    case "g4": {
      // columns: intervention, alzheimer_trials, parkinson_trials
      // Bipartite bridge: Alzheimer ←[intervention]→ Parkinson
      const maxVal = Math.max(...rows.map(r => (r.alzheimer_trials || 0) + (r.parkinson_trials || 0)));
      const nodes = [
        { id: "__alz__", label: "Alzheimer\nDisease",  color: TYPE_COLORS.condition, size: 20, nodeType: "condition" },
        { id: "__par__", label: "Parkinson\nDisease",  color: TYPE_COLORS.condition, size: 20, nodeType: "condition" },
        ...rows.map(r => ({
          id: r.intervention,
          label: r.intervention,
          color: TYPE_COLORS.intervention,
          size: 4 + 12 * (((r.alzheimer_trials || 0) + (r.parkinson_trials || 0)) / maxVal),
          val: (r.alzheimer_trials || 0) + (r.parkinson_trials || 0),
          nodeType: "intervention",
          detail: `Alz: ${r.alzheimer_trials}  Par: ${r.parkinson_trials}`,
        })),
      ];
      const links = [
        ...rows.filter(r => r.alzheimer_trials > 0).map(r => ({
          source: "__alz__", target: r.intervention,
          label: `${r.alzheimer_trials}`, value: r.alzheimer_trials,
        })),
        ...rows.filter(r => r.parkinson_trials > 0).map(r => ({
          source: "__par__", target: r.intervention,
          label: `${r.parkinson_trials}`, value: r.parkinson_trials,
        })),
      ];
      return { nodes, links };
    }

    case "g5": {
      // columns: condition, total, terminated, termination_pct
      // Hub-spoke: TERMINATED risk hub → conditions, node size = termination_pct
      const maxPct = Math.max(...rows.map(r => r.termination_pct || 1));
      return {
        nodes: [
          { id: "__risk__", label: "Termination\nRisk", color: "#ef4444", size: 16, nodeType: "hub" },
          ...rows.map(r => ({
            id: r.condition,
            label: r.condition,
            // Red gradient: high pct = red, low = amber
            color: `hsl(${Math.round(40 - 40 * (r.termination_pct / maxPct))}, 85%, 55%)`,
            size: 5 + 18 * (r.termination_pct / maxPct),
            val: r.termination_pct,
            nodeType: "condition",
            detail: `${r.termination_pct}% terminated (${r.terminated}/${r.total})`,
          })),
        ],
        links: rows.map(r => ({
          source: "__risk__",
          target: r.condition,
          label: `${r.termination_pct}%`,
          value: r.termination_pct,
        })),
      };
    }

    default:
      return buildHeuristicGraph(columns, rows);
  }
}

// Heuristic builder for freeform Cypher results
function buildHeuristicGraph(columns, rows) {
  const numCols  = columns.filter(c => typeof rows[0]?.[c] === "number");
  const strCols  = columns.filter(c => typeof rows[0]?.[c] === "string");
  if (strCols.length === 0) return null;

  const primaryCol = strCols[0];
  const weightCol  = numCols[0];
  const maxVal = weightCol ? Math.max(...rows.map(r => r[weightCol] || 0)) : 1;

  const hubId = `__hub__`;
  const nodes = [
    { id: hubId, label: primaryCol, color: TYPE_COLORS.hub, size: 16, nodeType: "hub" },
    ...rows.slice(0, 30).map(r => ({
      id: String(r[primaryCol]),
      label: String(r[primaryCol]),
      color: TYPE_COLORS.condition,
      size: weightCol ? 5 + 15 * ((r[weightCol] || 0) / maxVal) : 10,
      val: weightCol ? r[weightCol] : null,
      nodeType: primaryCol,
      detail: weightCol ? `${weightCol}: ${r[weightCol]}` : null,
    })),
  ];
  const links = rows.slice(0, 30).map(r => ({
    source: hubId,
    target: String(r[primaryCol]),
    value: weightCol ? (r[weightCol] || 1) : 1,
  }));
  return { nodes, links };
}

// ── Main component ────────────────────────────────────────────────────────────
export default function GraphViz({ queryId, columns, rows }) {
  const containerRef = useRef(null);
  const fgRef = useRef(null);
  const [width, setWidth] = useState(700);
  const [tooltip, setTooltip] = useState(null);

  // Responsive width tracking
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      setWidth(entries[0].contentRect.width || 700);
    });
    ro.observe(el);
    setWidth(el.clientWidth || 700);
    return () => ro.disconnect();
  }, []);

  const isSchemaView = !queryId || !rows || rows.length === 0;

  const graphData = useMemo(() => {
    if (isSchemaView) return SCHEMA_DATA;
    return buildGraphData(queryId, columns, rows) ?? SCHEMA_DATA;
  }, [isSchemaView, queryId, columns, rows]);

  // Fit camera after graph data changes
  useEffect(() => {
    const timer = setTimeout(() => fgRef.current?.zoomToFit(400, 48), 600);
    return () => clearTimeout(timer);
  }, [graphData]);

  // Per-node canvas renderer
  const nodeCanvasObject = useCallback((node, ctx, globalScale) => {
    const size = node.size || 8;
    const lines = (node.label || node.id).split("\n");
    const isHeavy = node.nodeType === "hub" || node.nodeType === "schema";

    // Glow for heavy nodes
    if (isHeavy) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, size + 4, 0, 2 * Math.PI);
      ctx.fillStyle = node.color + "28";
      ctx.fill();
    }

    // Circle
    ctx.beginPath();
    ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
    ctx.fillStyle = node.color;
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1.5 / globalScale;
    ctx.stroke();

    // Label text
    const fontSize = Math.max(7, Math.min(13, size * 0.85)) / globalScale;
    ctx.font = `${isHeavy ? "600 " : ""}${fontSize}px Inter,sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";

    const lineH = fontSize + 1.5;
    if (lines.length > 1) {
      lines.forEach((line, i) => {
        ctx.fillText(line, node.x, node.y + (i - (lines.length - 1) / 2) * lineH);
      });
    } else {
      // Truncate to fit node circle
      let label = lines[0];
      const maxW = size * 1.9;
      while (ctx.measureText(label).width > maxW && label.length > 4) {
        label = label.slice(0, -2) + "…";
      }
      ctx.fillText(label, node.x, node.y);
    }
  }, []);

  const linkCanvasObject = useCallback((link, ctx, globalScale) => {
    const { source: s, target: t } = link;
    if (!s?.x || !t?.x) return;

    // Compute max link value for scaling
    const maxVal = Math.max(...graphData.links.map(l => l.value || 1));
    const lineW = link.value ? 0.5 + 2.5 * (link.value / maxVal) : 1;

    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(t.x, t.y);
    ctx.strokeStyle = "rgba(148,163,184,0.45)";
    ctx.lineWidth = lineW / globalScale;
    ctx.stroke();

    // Edge label at midpoint — only when zoomed in
    if (link.label && globalScale > 1.8) {
      const mx = (s.x + t.x) / 2;
      const my = (s.y + t.y) / 2;
      const fs = 8 / globalScale;
      ctx.font = `${fs}px sans-serif`;
      ctx.fillStyle = "rgba(203,213,225,0.85)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(link.label, mx, my);
    }
  }, [graphData]);

  const handleNodeHover = useCallback((node) => {
    setTooltip(node || null);
    if (containerRef.current) {
      containerRef.current.style.cursor = node ? "pointer" : "default";
    }
  }, []);

  return (
    <div ref={containerRef} className="graph-viz-wrap">
      {isSchemaView && (
        <div className="graph-viz-schema-label">
          KG Schema — 5 node types · {(580489 + 49929 + 129085 + 512289 + 225).toLocaleString()} total nodes
        </div>
      )}
      <ForceGraph2D
        ref={fgRef}
        graphData={graphData}
        width={width}
        height={420}
        backgroundColor="#0f172a"
        nodeCanvasObject={nodeCanvasObject}
        nodeCanvasObjectMode={() => "replace"}
        linkCanvasObject={linkCanvasObject}
        linkCanvasObjectMode={() => "replace"}
        onNodeHover={handleNodeHover}
        nodeLabel={() => ""}
        cooldownTicks={isSchemaView ? 80 : 150}
        d3AlphaDecay={isSchemaView ? 0.04 : 0.015}
        d3VelocityDecay={0.35}
        enableZoomInteraction
        enablePanInteraction
      />
      {tooltip && (
        <div className="graph-viz-tooltip">
          <strong>{(tooltip.label || tooltip.id).replace("\n", " ")}</strong>
          {tooltip.detail && <div>{tooltip.detail}</div>}
          {tooltip.via && <div className="graph-viz-tooltip-via">via: {tooltip.via}</div>}
          {!tooltip.detail && tooltip.val != null && (
            <div>{tooltip.nodeType}: {Number(tooltip.val).toLocaleString()}</div>
          )}
        </div>
      )}
      <div className="graph-viz-legend">
        {isSchemaView ? (
          <>
            <span className="gvl-dot" style={{ background: "#0ea5e9" }} /> Trial
            <span className="gvl-dot" style={{ background: "#6366f1" }} /> Sponsor
            <span className="gvl-dot" style={{ background: "#10b981" }} /> Condition
            <span className="gvl-dot" style={{ background: "#f59e0b" }} /> Intervention
            <span className="gvl-dot" style={{ background: "#ec4899" }} /> Country
          </>
        ) : (
          <>
            <span className="gvl-dot" style={{ background: "#0ea5e9" }} /> Hub
            {columns?.includes("condition") || columns?.includes("expansion_target") ? <><span className="gvl-dot" style={{ background: "#10b981" }} /> Condition</> : null}
            {columns?.includes("sponsor") ? <><span className="gvl-dot" style={{ background: "#6366f1" }} /> Sponsor</> : null}
            {columns?.includes("intervention") ? <><span className="gvl-dot" style={{ background: "#f59e0b" }} /> Intervention</> : null}
            <span className="gvl-hint">Node size = weight · Scroll to zoom · Drag to pan</span>
          </>
        )}
      </div>
    </div>
  );
}
