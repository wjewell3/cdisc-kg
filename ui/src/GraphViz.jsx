/**
 * GraphViz — Cytoscape-powered graph that transitions between schema and
 * traversal views.
 *
 * Idle:  5 proportional bubbles at schema positions with relationship arrows.
 * Query: bubbles animate into a mirror layout.  Types that appear multiple
 *        times "split" — each instance gets its own greyed-out satellites
 *        for unused node types.
 */
import { useRef, useEffect, useState, useMemo } from "react";
import cytoscape from "cytoscape";

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

// ── Format count for bubble labels ───────────────────────────────────────────
function fmtCount(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

const VW = 590, VH = 278;
const CX = VW / 2, CY = VH / 2;

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

// ── Cytoscape stylesheet ─────────────────────────────────────────────────────
const CY_STYLE = [
  // Default node
  {
    selector: "node",
    style: {
      shape: "ellipse",
      width: "data(size)",
      height: "data(size)",
      "background-color": "data(bgColor)",
      "background-opacity": 0.8,
      "border-width": 1,
      "border-color": "data(borderColor)",
      label: "data(displayLabel)",
      "text-valign": "center",
      "text-halign": "center",
      color: "#fff",
      "text-wrap": "wrap",
      "font-size": 11,
      "font-weight": 600,
      "text-max-width": 80,
      "overlay-opacity": 0,
      "text-outline-color": "#0f172a",
      "text-outline-width": 0,
    },
  },
  // Medium nodes: smaller font
  {
    selector: "node[size < 56][size >= 24]",
    style: { "font-size": 8 },
  },
  // Small nodes: text below
  {
    selector: "node[size < 24]",
    style: {
      "font-size": 9,
      "font-weight": 600,
      "text-valign": "bottom",
      "text-margin-y": 5,
      color: "data(borderColor)",
    },
  },
  // Active nodes above schema edges
  {
    selector: "node:not(.satellite)",
    style: { "z-index": 5 },
  },
  // Result node glow
  {
    selector: "node.result",
    style: {
      "border-width": 3,
      "border-opacity": 0.6,
      "z-index": 6,
    },
  },
  // Schema edges
  {
    selector: "edge.schema",
    style: {
      width: 1.5,
      "line-color": "#475569",
      "target-arrow-color": "#475569",
      "target-arrow-shape": "triangle",
      "arrow-scale": 0.8,
      "curve-style": "bezier",
      label: "data(displayLabel)",
      "font-size": 8,
      "font-weight": 600,
      color: "#64748b",
      "text-rotation": "none",
      "text-wrap": "none",
      "text-background-color": "#0f172a",
      "text-background-opacity": 1,
      "text-background-padding": 3,
      "text-margin-y": -18,
    },
  },
  // Path edges (traversal) — high z-index to render over satellites
  {
    selector: "edge.path-edge",
    style: {
      width: 2,
      "line-color": "#38bdf8",
      "target-arrow-color": "#38bdf8",
      "target-arrow-shape": "triangle",
      "arrow-scale": 0.8,
      "curve-style": "bezier",
      label: "data(label)",
      "font-size": 8,
      "font-weight": 700,
      color: "#7dd3fc",
      "text-rotation": "none",
      "text-wrap": "none",
      "text-background-color": "#0f172a",
      "text-background-opacity": 1,
      "text-background-padding": 3,
      "text-margin-y": -18,
      "z-index": 10,
    },
  },
  // Reverse traversal edges (canonical arrow direction, dashed)
  {
    selector: "edge.path-edge-rev",
    style: {
      "line-style": "dashed",
      "line-dash-pattern": [6, 3],
    },
  },
  // Satellite edges (dim connectors)
  {
    selector: "edge.sat-edge",
    style: {
      width: 1,
      "line-color": "#334155",
      "target-arrow-color": "#334155",
      "target-arrow-shape": "triangle",
      "arrow-scale": 0.6,
      "curve-style": "bezier",
      opacity: 0.35,
    },
  },
];

// ── Build initial schema elements for Cytoscape ──────────────────────────────
function buildSchemaElements() {
  const els = [];
  for (const n of NODES) {
    const big = n.r >= 28;
    els.push({
      group: "nodes",
      data: {
        id: n.id,
        typeId: n.id,
        size: n.r * 2,
        bgColor: n.color,
        borderColor: n.color,
        displayLabel: big ? `${n.label}\n${n.count}`
                     : n.r >= 12 ? `${n.count}\n${n.label}`
                     : n.label,
      },
      position: { x: n.x, y: n.y },
    });
  }
  for (const e of EDGES) {
    els.push({
      group: "edges",
      data: {
        id: `se-${e.label}`,
        source: e.from,
        target: e.to,
        displayLabel: e.label,
        label: e.label,
      },
      classes: "schema",
    });
  }
  return els;
}

// ── Compute path layout with satellites per split ────────────────────────────
function computePathLayout(path) {
  const steps = path.steps.filter(s => s.type === "node");
  const edgeSteps = path.steps.filter(s => s.type === "edge");
  const N = steps.length;
  const mid = Math.floor(N / 2);

  // Fit within viewbox with room for satellites
  const padding = 84; // max radius (44) + satellite room (40)
  const hSpacing = Math.min((VW - 2 * padding) / Math.max(1, N - 1), 120);
  const yAmp = 30;

  // Assign node IDs (first instance reuses schema ID, clones get _1, _2…)
  const typeCounter = {};
  const activeNodes = steps.map((s, i) => {
    const count = typeCounter[s.id] || 0;
    typeCounter[s.id] = count + 1;
    return {
      nodeId: count === 0 ? s.id : `${s.id}_${count}`,
      typeId: s.id,
      step: i,
      label: s.label,
      note: s.note,
      x: Math.round(CX + (i - mid) * hSpacing),
      y: Math.round(CY + (i % 2 === 0 ? -yAmp : yAmp) * (N > 2 ? 1 : 0)),
    };
  });

  // Path edges (between consecutive active nodes).
  // When dir="←" the query traverses the KG edge BACKWARDS — swap source/target
  // so the arrow still points in the canonical KG relationship direction.
  const pathEdges = [];
  for (let i = 0; i < activeNodes.length - 1; i++) {
    const eDef = edgeSteps[i];
    const reverse = eDef?.dir === "←";
    pathEdges.push({
      id: `pe_${i}`,
      source: reverse ? activeNodes[i + 1].nodeId : activeNodes[i].nodeId,
      target: reverse ? activeNodes[i].nodeId     : activeNodes[i + 1].nodeId,
      label: eDef?.label || "",
      reverse,
    });
  }

  return { activeNodes, pathEdges };
}

// ── Main component ────────────────────────────────────────────────────────────
export default function GraphViz({ queryId, filterStats }) {
  const containerRef = useRef(null);
  const cyRef = useRef(null);
  const prevQueryRef = useRef(null);
  const [descVisible, setDescVisible] = useState(false);

  const path = QUERY_PATHS[queryId] ?? null;

  // Compute effective counts: filter stats override defaults when present
  const effectiveCounts = useMemo(() => {
    const defaults = { Trial: "580k", Sponsor: "49.9k", Condition: "129k", Intervention: "512k", Country: "225" };
    if (!filterStats) return defaults;
    return {
      Trial: filterStats.total != null ? fmtCount(filterStats.total) : defaults.Trial,
      Sponsor: filterStats.sponsors != null ? fmtCount(filterStats.sponsors) : defaults.Sponsor,
      Condition: filterStats.conditions != null ? fmtCount(filterStats.conditions) : defaults.Condition,
      Intervention: filterStats.interventions != null ? fmtCount(filterStats.interventions) : defaults.Intervention,
      Country: filterStats.countries != null ? fmtCount(filterStats.countries) : defaults.Country,
    };
  }, [filterStats]);

  // Initialize Cytoscape once
  useEffect(() => {
    const cy = cytoscape({
      container: containerRef.current,
      elements: buildSchemaElements(),
      style: CY_STYLE,
      layout: { name: "preset" },
      userZoomingEnabled: false,
      userPanningEnabled: false,
      boxSelectionEnabled: false,
      autoungrabify: true,
    });
    cy.fit(undefined, 28);
    cyRef.current = cy;
    return () => cy.destroy();
  }, []);

  // Transition on queryId change
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    setDescVisible(false);

    // Stop any running animations
    cy.nodes().stop(true);
    cy.edges().stop(true);

    // Remove clones and overlay edges from previous state
    cy.elements(".clone, .path-edge").remove();

    if (!path) {
      // ── Return to schema ──
      NODES.forEach(n => {
        const node = cy.getElementById(n.id);
        if (!node.length) return;
        const big = n.r >= 28;
        const count = effectiveCounts[n.id] || n.count;
        node.removeClass("satellite result active");
        node.data({
          bgColor: n.color,
          borderColor: n.color,
          displayLabel: big ? `${n.label}\n${count}`
                       : n.r >= 12 ? `${count}\n${n.label}`
                       : n.label,
          size: n.r * 2,
        });
        node.animate({ position: { x: n.x, y: n.y }, style: { opacity: 1 } },
          { duration: 500, easing: "ease-in-out-cubic" });
      });
      cy.edges(".schema").animate({ style: { opacity: 1 } }, { duration: 400 });
      return;
    }

    // ── Transition to path ──
    const { activeNodes, pathEdges } = computePathLayout(path);

    // Dim schema edges
    cy.edges(".schema").animate({ style: { opacity: 0.08 } }, { duration: 400 });

    // Hide unused schema nodes (types not in the path)
    const activeTypes = new Set(activeNodes.map(n => n.typeId));
    NODES.forEach(n => {
      if (activeTypes.has(n.id)) return;
      cy.getElementById(n.id).animate({ style: { opacity: 0 } }, { duration: 300 });
    });

    // Update original schema nodes that appear in the path
    activeNodes.forEach(n => {
      const def = NODE_MAP[n.typeId];
      const isFirst = n.nodeId === n.typeId;
      if (isFirst) {
        const node = cy.getElementById(n.typeId);
        if (!node.length) return;
        node.removeClass("satellite");
        node.addClass("active");
        if (n.note === "result") node.addClass("result");
        node.data({
          bgColor: def.color,
          borderColor: def.color,
          displayLabel: def.r >= 28 ? `${def.label}\n${n.label}` : n.label,
        });
        node.animate({ position: { x: n.x, y: n.y }, style: { opacity: 1 } },
          { duration: 600, easing: "ease-in-out-cubic" });
      }
    });

    // Add clone nodes for types that appear more than once
    const cloneNodes = [];
    activeNodes.forEach(n => {
      if (n.nodeId === n.typeId) return;
      const def = NODE_MAP[n.typeId];
      cloneNodes.push({
        group: "nodes",
        data: {
          id: n.nodeId,
          typeId: n.typeId,
          size: def.r * 2,
          bgColor: def.color,
          borderColor: def.color,
          displayLabel: def.r >= 28 ? `${def.label}\n${n.label}` : n.label,
        },
        classes: "clone" + (n.note === "result" ? " result" : ""),
        position: { x: def.x, y: def.y },
      });
    });
    cy.add(cloneNodes);

    requestAnimationFrame(() => {
      activeNodes.forEach(n => {
        if (n.nodeId === n.typeId) return;
        const node = cy.getElementById(n.nodeId);
        if (!node.length) return;
        node.animate({ position: { x: n.x, y: n.y } },
          { duration: 600, easing: "ease-in-out-cubic" });
      });

      setTimeout(() => {
        const edgeEls = pathEdges.map(pe => ({
          group: "edges",
          data: { id: pe.id, source: pe.source, target: pe.target, label: pe.label },
          classes: pe.reverse ? "path-edge path-edge-rev" : "path-edge",
        }));
        cy.add(edgeEls);
        setDescVisible(true);
      }, 500);
    });

    prevQueryRef.current = queryId;
  }, [queryId, path, effectiveCounts]);

  return (
    <div className="graph-viz-wrap">
      <div ref={containerRef} className="graph-viz-cy" />

      {/* Description */}
      {path ? (
        <div className="qpe-wrap"
          style={{ opacity: descVisible ? 1 : 0, transition: "opacity 0.3s" }}>
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