import { useState, useCallback, useRef, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import ForceGraph2D from "react-force-graph-2d";
import staticData from "./graphData.json";
import QueryPanel from "./QueryPanel";
import TreeView from "./TreeView";
import TutorPanel from "./TutorPanel";
import DemoPanel from "./DemoPanel";
import TrialsPanel from "./TrialsPanel";
import SiteIntelligence from "./SiteIntelligence";
import "./App.css";

// All graph data is bundled statically — no backend needed for the explorer
const ALL_NODES = staticData.graph.nodes;
const ALL_EDGES = staticData.graph.edges;
const DOMAINS_MAP = staticData.domains;
const STATIC_STATS = staticData.stats;
const STATIC_DOMAINS = Object.entries(DOMAINS_MAP).map(([id, d]) => ({
  id,
  name: d.name,
}));

const CORE_ORDER = { Req: 0, Exp: 1, Perm: 2 };

// Build codelist_id → values lookup from domain variable metadata
const CODELIST_VALUES = {};
for (const dom of Object.values(DOMAINS_MAP)) {
  for (const v of dom.variables) {
    if (v.codelist && !CODELIST_VALUES[v.codelist.id]) {
      CODELIST_VALUES[v.codelist.id] = { name: v.codelist.name, values: v.codelist.values };
    }
  }
}
const NODE_MAP = Object.fromEntries(ALL_NODES.map((n) => [n.id, n]));

const ROUTE_TO_PANEL = {
  "/": "graph",
  "/query": "query",
  "/browse": "browse",
  "/learn": "learn",
  "/demo": "demo",
  "/trials": "trials",
  "/sites": "sites",
};
const PANEL_TO_ROUTE = Object.fromEntries(Object.entries(ROUTE_TO_PANEL).map(([k, v]) => [v, k]));

// Derive format/constraint info from SDTM naming conventions
function getVariableFormat(v) {
  const name = v.name || v.id?.split(".").pop() || "";
  const info = [];

  // Date/time variables (suffix DTC)
  if (name.endsWith("DTC")) {
    info.push({ label: "Format", value: "ISO 8601", detail: "YYYY-MM-DDThh:mm:ss" });
    info.push({ label: "Example", value: "2024-03-15T14:30:00", detail: "Partial dates allowed: 2024-03 or 2024" });
  }
  // Study day variables (suffix DY)
  else if (name.endsWith("DY")) {
    info.push({ label: "Format", value: "Integer", detail: "Positive = on/after reference date, negative = before. Day 1 = reference date (no day 0)" });
    info.push({ label: "Example", value: "-7, 1, 15" });
  }
  // Sequence number
  else if (name.endsWith("SEQ")) {
    info.push({ label: "Format", value: "Positive integer", detail: "Unique per subject within the domain, starting at 1" });
  }
  // Flag variables (suffix FL)
  else if (name.endsWith("FL")) {
    info.push({ label: "Format", value: "Single character", detail: "Y or N (from NY codelist). Null if not applicable." });
  }
  // Test code variables (suffix TESTCD)
  else if (name.endsWith("TESTCD")) {
    info.push({ label: "Format", value: "≤ 8 characters", detail: "Short uppercase code, no spaces. Maps to the full test name in --TEST." });
  }
  // Numeric result (suffix STRESN)
  else if (name.endsWith("STRESN")) {
    info.push({ label: "Format", value: "Decimal number", detail: "Numeric result in standard units. Null if result is non-numeric." });
  }
  // Character result (suffix STRESC or ORRES)
  else if (name.endsWith("STRESC") || name.endsWith("ORRES")) {
    info.push({ label: "Format", value: "Free text or numeric as character", detail: "All results stored as character. Use --STRESN for numeric analysis." });
  }
  // Dose (DOSE)
  else if (name.endsWith("DOSE") && !name.endsWith("DOSU")) {
    info.push({ label: "Format", value: "Decimal number", detail: "Amount per administration. 0 = no dose given." });
  }
  // General Num vs Char
  else if ((v.data_type || v.type) === "Num") {
    info.push({ label: "Format", value: "Numeric" });
  } else if ((v.data_type || v.type) === "Char") {
    info.push({ label: "Format", value: "Character (≤ 200 chars)" });
  }

  // Add codelist constraint if applicable
  const cid = v.codelist?.id || v.codelist_id;
  if (cid && CODELIST_VALUES[cid]) {
    info.push({ label: "Controlled by", value: `${CODELIST_VALUES[cid].name} (${cid})`, detail: `Only these values: ${CODELIST_VALUES[cid].values.join(", ")}` });
  }

  return info;
}

function computeNeighborhood(nodeId, depth = 2) {
  const nodeMap = Object.fromEntries(ALL_NODES.map((n) => [n.id, n]));
  const adjacency = {};
  for (const e of ALL_EDGES) {
    (adjacency[e.source] ||= []).push(e.target);
    (adjacency[e.target] ||= []).push(e.source);
  }
  const visited = new Set([nodeId]);
  let frontier = [nodeId];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const n of frontier) {
      for (const nb of adjacency[n] || []) {
        if (!visited.has(nb)) { visited.add(nb); next.push(nb); }
      }
    }
    frontier = next;
  }
  const nodes = [...visited].map((id) => nodeMap[id]).filter(Boolean);
  const edges = ALL_EDGES.filter((e) => visited.has(e.source) && visited.has(e.target));
  return { nodes, edges };
}

function searchNodes(query) {
  const q = query.toLowerCase();
  return ALL_NODES.filter(
    (n) =>
      n.name?.toLowerCase().includes(q) ||
      n.label?.toLowerCase().includes(q) ||
      n.description?.toLowerCase().includes(q)
  ).slice(0, 20);
}

const NODE_COLORS = {
  Standard: "#e74c3c",
  Class: "#e67e22",
  Domain: "#3498db",
  Variable: "#2ecc71",
  Codelist: "#9b59b6",
  CodelistValue: "#bdc3c7",
};

const NODE_SIZES = {
  Standard: 12,
  Class: 10,
  Domain: 8,
  Variable: 4,
  Codelist: 6,
  CodelistValue: 3,
};

function toForceGraph(data) {
  return {
    nodes: data.nodes.map((n) => ({
      ...n,
      color: NODE_COLORS[n.type] || "#999",
      val: NODE_SIZES[n.type] || 4,
    })),
    links: data.edges.map((e) => ({
      source: e.source,
      target: e.target,
      relationship: e.relationship,
    })),
  };
}

function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const initialPanel = ROUTE_TO_PANEL[location.pathname] || "graph";

  const [graphData, setGraphData] = useState(() => toForceGraph({ nodes: ALL_NODES, edges: ALL_EDGES }));
  const [selectedNode, setSelectedNode] = useState(null);
  const [domainDetail, setDomainDetail] = useState(null);
  const [domains] = useState(STATIC_DOMAINS);
  const [stats] = useState(STATIC_STATS);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [viewMode, setViewMode] = useState("full");
  const [activePanel, setActivePanel] = useState(initialPanel);
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pendingTrialId, setPendingTrialId] = useState(null);
  const fgRef = useRef();

  // Sync URL → panel when browser back/forward
  useEffect(() => {
    const panel = ROUTE_TO_PANEL[location.pathname] || "graph";
    setActivePanel(panel);
  }, [location.pathname]);

  // Navigate when panel changes
  const switchPanel = useCallback((panel) => {
    setActivePanel(panel);
    const route = PANEL_TO_ROUTE[panel] || "/";
    if (location.pathname !== route) {
      navigate(route);
    }
  }, [navigate, location.pathname]);

  const handleNodeClick = useCallback((node) => {
    setSelectedNode(node);
    setSelectedEdge(null);
    if (node.type === "Domain") {
      setDomainDetail(DOMAINS_MAP[node.domain_code] || null);
    } else {
      setDomainDetail(null);
    }
  }, []);

  const handleLinkClick = useCallback((link) => {
    const src = typeof link.source === "object" ? link.source : NODE_MAP[link.source];
    const tgt = typeof link.target === "object" ? link.target : NODE_MAP[link.target];
    const fullEdge = ALL_EDGES.find(
      (e) =>
        (e.source === (src?.id || link.source)) &&
        (e.target === (tgt?.id || link.target)) &&
        e.relationship === link.relationship
    );
    setSelectedEdge({ ...link, ...(fullEdge || {}), _src: src, _tgt: tgt });
    setSelectedNode(null);
    setDomainDetail(null);
  }, []);

  const handleSearch = useCallback(() => {
    if (!searchQuery.trim()) return;
    setSearchResults(searchNodes(searchQuery));
  }, [searchQuery]);

  const focusNode = useCallback((nodeId) => {
    setViewMode("neighborhood");
    const data = computeNeighborhood(nodeId, 2);
    setGraphData(toForceGraph(data));
    const node = data.nodes.find((n) => n.id === nodeId);
    if (node) {
      setSelectedNode({ ...node, color: NODE_COLORS[node.type] });
      if (node.type === "Domain") {
        setDomainDetail(DOMAINS_MAP[node.domain_code] || null);
      } else {
        setDomainDetail(null);
      }
    }
  }, []);

  const resetView = useCallback(() => {
    setViewMode("full");
    setSelectedNode(null);
    setDomainDetail(null);
    setGraphData(toForceGraph({ nodes: ALL_NODES, edges: ALL_EDGES }));
  }, []);

  const nodeCanvasObject = useCallback(
    (node, ctx, globalScale) => {
      const size = node.val || 4;
      ctx.beginPath();
      ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
      ctx.fillStyle = node.color || "#999";
      ctx.fill();

      if (selectedNode && selectedNode.id === node.id) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2 / globalScale;
        ctx.stroke();
      }

      if (size >= 6 || globalScale > 1.5) {
        const fontSize = Math.max(10 / globalScale, 2);
        ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = "#e0e0e0";
        ctx.fillText(node.name || "", node.x, node.y + size + 2);
      }
    },
    [selectedNode]
  );

  const linkCanvasObject = useCallback((link, ctx, globalScale) => {
    const start = link.source;
    const end = link.target;
    if (typeof start !== "object" || typeof end !== "object") return;

    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 0.5;
    ctx.stroke();

    if (globalScale > 2) {
      const midX = (start.x + end.x) / 2;
      const midY = (start.y + end.y) / 2;
      const fontSize = Math.max(7 / globalScale, 1.5);
      ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.fillText(link.relationship || "", midX, midY);
    }
  }, []);

  return (
    <div className="app">
      <header className="header">
        <button className="hamburger" onClick={() => setSidebarOpen((o) => !o)} aria-label="Toggle sidebar">
          ☰
        </button>
        <h1>CDISC Knowledge Graph</h1>
        <span className="subtitle">SDTM IG v3.4</span>
        <div className="tab-bar">
          <button
            className={`tab-btn ${activePanel === "graph" ? "active" : ""}`}
            onClick={() => switchPanel("graph")}
          >
            Graph
          </button>
          <button
            className={`tab-btn ${activePanel === "query" ? "active" : ""}`}
            onClick={() => switchPanel("query")}
          >
            NL Query
          </button>
          <button
            className={`tab-btn ${activePanel === "browse" ? "active" : ""}`}
            onClick={() => switchPanel("browse")}
          >
            Browse
          </button>
          <button
            className={`tab-btn ${activePanel === "learn" ? "active" : ""}`}
            onClick={() => switchPanel("learn")}
          >
            Learn
          </button>
          <button
            className={`tab-btn ${activePanel === "demo" ? "active" : ""}`}
            onClick={() => switchPanel("demo")}
          >
            Demo
          </button>
          <button
            className={`tab-btn tab-btn-trials ${activePanel === "trials" ? "active" : ""}`}
            onClick={() => switchPanel("trials")}
          >
            Trials ✦
          </button>
          <button
            className={`tab-btn tab-btn-sites ${activePanel === "sites" ? "active" : ""}`}
            onClick={() => switchPanel("sites")}
          >
            Sites ⬙
          </button>
        </div>
        {stats && (
          <span className="stats-badge">
            {stats.total_nodes} nodes · {stats.total_edges} edges
          </span>
        )}
      </header>

      <div className="main">
        {/* Sidebar overlay for mobile */}
        {sidebarOpen && activePanel !== "browse" && activePanel !== "learn" && activePanel !== "demo" && activePanel !== "trials" && activePanel !== "sites" && (
          <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
        )}

        {/* Left sidebar — hidden on Browse tab */}
        <aside className={`sidebar${sidebarOpen ? " sidebar-open" : ""}${activePanel === "browse" || activePanel === "learn" || activePanel === "demo" || activePanel === "trials" || activePanel === "sites" ? " sidebar-hidden" : ""}`}>
          <div className="panel">
            <h3>Search</h3>
            <div className="search-box">
              <input
                type="text"
                placeholder="Search variables, domains..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              />
              <button onClick={handleSearch}>Go</button>
            </div>
            {searchResults.length > 0 && (
              <ul className="search-results">
                {searchResults.map((r) => (
                  <li key={r.id} onClick={() => focusNode(r.id)}>
                    <span
                      className="type-badge"
                      style={{ background: NODE_COLORS[r.type] }}
                    >
                      {r.type}
                    </span>
                    <span className="result-name">{r.name}</span>
                    {r.label && (
                      <span className="result-label">{r.label}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="panel">
            <h3>SDTM Domains</h3>
            <ul className="domain-list">
              {domains.map((d) => (
                <li
                  key={d.id}
                  className={
                    selectedNode?.domain_code === d.id ? "active" : ""
                  }
                  onClick={() => focusNode(`domain:${d.id}`)}
                >
                  <strong>{d.id}</strong> — {d.name}
                </li>
              ))}
            </ul>
          </div>

          <div className="panel">
            <h3>View</h3>
            <button className="btn" onClick={resetView}>
              Reset to Full Graph
            </button>
            {viewMode === "neighborhood" && (
              <p className="view-note">Showing neighborhood view</p>
            )}
          </div>

          <div className="panel">
            <h3>Legend</h3>
            <ul className="legend">
              {Object.entries(NODE_COLORS)
                .filter(([k]) => k !== "CodelistValue")
                .map(([type, color]) => (
                  <li key={type}>
                    <span
                      className="legend-dot"
                      style={{ background: color }}
                    />
                    {type}
                  </li>
                ))}
            </ul>
          </div>
        </aside>

        {/* Graph canvas */}
        <div className={`graph-container${activePanel === "browse" || activePanel === "learn" || activePanel === "demo" || activePanel === "trials" || activePanel === "sites" ? " graph-hidden" : ""}`}>
          <ForceGraph2D
            ref={fgRef}
            graphData={graphData}
            nodeCanvasObject={nodeCanvasObject}
            linkCanvasObject={linkCanvasObject}
            onNodeClick={handleNodeClick}
            onLinkClick={handleLinkClick}
            linkLabel={(l) => l.relationship || ""}
            nodeLabel={(n) =>
              `${n.type}: ${n.name}${n.label ? ` (${n.label})` : ""}`
            }
            backgroundColor="#0d1117"
            d3AlphaDecay={0.02}
            d3VelocityDecay={0.3}
            warmupTicks={50}
            cooldownTicks={100}
          />
        </div>

        {/* Right detail panel */}
        {selectedNode && activePanel === "graph" && (
          <aside className="detail-panel">
            <button
              className="close-btn"
              onClick={() => {
                setSelectedNode(null);
                setDomainDetail(null);
              }}
            >
              ×
            </button>
            <h3>
              <span
                className="type-badge"
                style={{ background: NODE_COLORS[selectedNode.type] }}
              >
                {selectedNode.type}
              </span>
              {selectedNode.name}
            </h3>
            {selectedNode.label && (
              <p className="detail-label">{selectedNode.label}</p>
            )}
            {selectedNode.description && (
              <p className="detail-desc">{selectedNode.description}</p>
            )}

            {selectedNode.type === "Variable" && (
              <div className="detail-section">
                <div className="detail-row">
                  <span>Domain:</span>
                  <span>{selectedNode.domain}</span>
                </div>
                <div className="detail-row">
                  <span>Type:</span>
                  <span>{selectedNode.data_type}</span>
                </div>
                <div className="detail-row">
                  <span>Core:</span>
                  <span className={`core-${selectedNode.core?.toLowerCase()}`}>
                    {selectedNode.core}
                  </span>
                </div>
                <div className="detail-row">
                  <span>Role:</span>
                  <span>{selectedNode.role}</span>
                </div>
                {getVariableFormat(selectedNode).length > 0 && (
                  <div className="format-section">
                    <h4>Format & Constraints</h4>
                    {getVariableFormat(selectedNode).map((f, i) => (
                      <div key={i} className="format-row">
                        <span className="format-label">{f.label}:</span>
                        <span className="format-value">{f.value}</span>
                        {f.detail && <span className="format-detail">{f.detail}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {selectedNode.type === "Codelist" && selectedNode.codelist_id && CODELIST_VALUES[selectedNode.codelist_id] && (
              <div className="detail-section">
                <h4>Allowed Values ({CODELIST_VALUES[selectedNode.codelist_id].values.length})</h4>
                <ul className="codelist-values">
                  {CODELIST_VALUES[selectedNode.codelist_id].values.map((val) => (
                    <li key={val}>{val}</li>
                  ))}
                </ul>
              </div>
            )}

            {domainDetail && (
              <div className="detail-section">
                <h4>Variables ({domainDetail.variables.length})</h4>
                <table className="var-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Label</th>
                      <th>Core</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...domainDetail.variables]
                      .sort((a, b) => (CORE_ORDER[a.core] ?? 9) - (CORE_ORDER[b.core] ?? 9))
                      .map((v) => (
                      <tr
                        key={v.name}
                        onClick={() =>
                          focusNode(
                            `variable:${domainDetail.domain_code}.${v.name}`
                          )
                        }
                        className="clickable"
                      >
                        <td>
                          <code>{v.name}</code>
                          {v.codelist && (
                            <span
                              className="codelist-tag"
                              onClick={(e) => {
                                e.stopPropagation();
                                focusNode(`codelist:${v.codelist.id}`);
                              }}
                            >
                              {v.codelist.id}
                            </span>
                          )}
                        </td>
                        <td>{v.label}</td>
                        <td className={`core-${v.core.toLowerCase()}`}>
                          {v.core}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {domainDetail.related_domains.length > 0 && (
                  <>
                    <h4>Related Domains</h4>
                    <ul className="related-list">
                      {domainDetail.related_domains.map((r, i) => (
                        <li
                          key={i}
                          onClick={() => focusNode(`domain:${r.domain}`)}
                        >
                          <strong>{r.domain}</strong> — {r.relationship}
                          {r.via_variable && (
                            <span className="via"> via {r.via_variable}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </aside>
        )}
        {/* Edge detail panel */}
        {selectedEdge && activePanel === "graph" && (
          <aside className="detail-panel">
            <button className="close-btn" onClick={() => setSelectedEdge(null)}>×</button>
            <h3 className="edge-title">
              <span className="type-badge" style={{ background: NODE_COLORS[selectedEdge._src?.type] || "#666" }}>
                {selectedEdge._src?.name || "?"}
              </span>
              <span className="edge-arrow">→</span>
              <span className="type-badge" style={{ background: NODE_COLORS[selectedEdge._tgt?.type] || "#666" }}>
                {selectedEdge._tgt?.name || "?"}
              </span>
            </h3>
            <div className="detail-section">
              <div className="detail-row">
                <span>Relationship:</span>
                <span className="edge-rel">{selectedEdge.relationship}</span>
              </div>
              {selectedEdge.via_variable && (
                <div className="detail-row">
                  <span>Via variable:</span>
                  <span><code>{selectedEdge.via_variable}</code></span>
                </div>
              )}
              {selectedEdge.description && (
                <p className="detail-desc">{selectedEdge.description}</p>
              )}
            </div>
            <div className="edge-nodes">
              <div className="edge-node-card" onClick={() => selectedEdge._src && focusNode(selectedEdge._src.id)}>
                <span className="type-badge" style={{ background: NODE_COLORS[selectedEdge._src?.type] || "#666" }}>{selectedEdge._src?.type}</span>
                <strong>{selectedEdge._src?.name}</strong>
                {selectedEdge._src?.label && <span className="result-label">{selectedEdge._src.label}</span>}
              </div>
              <div className="edge-node-card" onClick={() => selectedEdge._tgt && focusNode(selectedEdge._tgt.id)}>
                <span className="type-badge" style={{ background: NODE_COLORS[selectedEdge._tgt?.type] || "#666" }}>{selectedEdge._tgt?.type}</span>
                <strong>{selectedEdge._tgt?.name}</strong>
                {selectedEdge._tgt?.label && <span className="result-label">{selectedEdge._tgt.label}</span>}
              </div>
            </div>
          </aside>
        )}

        {/* NL Query panel */}
        {activePanel === "query" && (
          <QueryPanel onFocusNode={(nodeId) => {
            switchPanel("graph");
            focusNode(nodeId);
          }} onBack={() => switchPanel("graph")} />
        )}

        {/* Browse / hierarchy tree */}
        {activePanel === "browse" && <TreeView />}

        {/* Learn / SDTM tutor */}
        {activePanel === "learn" && <TutorPanel />}

        {/* Demo / end-to-end pipeline */}
        {activePanel === "demo" && <DemoPanel />}

        {/* Trials / cross-trial AACT intelligence */}
        {activePanel === "trials" && <TrialsPanel focusNctId={pendingTrialId} />}

        {/* Sites / site intelligence */}
        {activePanel === "sites" && <SiteIntelligence onSelectTrial={(nct_id) => { setPendingTrialId(nct_id); switchPanel("trials"); }} />}
      </div>
    </div>
  );
}

export default App;
