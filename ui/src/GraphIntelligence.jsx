/**
 * GraphIntelligence — KG-native traversal queries surfaced in the UI.
 *
 * Currently available (no sites/countries needed):
 *   • Therapeutic Adjacency: conditions frequently co-treated by the same interventions
 *   • Sponsor Network: a sponsor's top conditions + competitive overlap
 *
 * Will unlock after full reload (sites/countries loaded):
 *   • Sponsor-Site Overlap, Site Risk, Site Expertise
 */
import { useState, useEffect } from "react";

const API_BASE = import.meta.env.VITE_TRIALS_API_BASE || "";

async function graphFetch(path, params = {}) {
  const url = new URL(API_BASE ? `${API_BASE}/api/graph/${path}` : `/api/graph`, window.location.origin);
  if (!API_BASE) url.searchParams.set("path", path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }
  const r = await fetch(url.toString());
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `HTTP ${r.status}`);
  }
  return r.json();
}

// ── Therapeutic Adjacency ─────────────────────────────────────────────────

function TherapeuticAdjacency() {
  const [condition, setCondition] = useState("");
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function search(e) {
    e.preventDefault();
    if (!condition.trim()) return;
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const data = await graphFetch("therapeutic-adjacency", { condition: condition.trim(), limit: 20 });
      // API returns a flat array of { condition, shared_interventions, example_drugs }
      setResults({ condition: condition.trim(), adjacent: Array.isArray(data) ? data : [] });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const maxWeight = results?.adjacent?.[0]?.shared_interventions ?? 1;

  return (
    <div className="kg-section">
      <div className="kg-section-header">
        <span className="kg-icon">&#x2b21;</span>
        <div>
          <h3>Therapeutic Adjacency</h3>
          <p>Conditions frequently targeted by the same interventions — drug repurposing signals &amp; competitive landscape</p>
        </div>
      </div>

      <form className="kg-search-form" onSubmit={search}>
        <input
          type="text"
          className="kg-input"
          placeholder="e.g., Type 2 Diabetes, Breast Cancer, Alzheimer Disease"
          value={condition}
          onChange={e => setCondition(e.target.value)}
        />
        <button type="submit" className="kg-btn" disabled={loading || !condition.trim()}>
          {loading ? "Searching…" : "Traverse →"}
        </button>
      </form>

      {error && <div className="kg-error">⚠ {error}</div>}

      {results && (
        <div className="kg-results">
          <div className="kg-results-meta">
            <span className="kg-badge-teal">{results.condition}</span>
            <span className="kg-meta-text">→ {results.adjacent.length} adjacent conditions found</span>
          </div>

          <div className="kg-explain">
            <strong>How to read this:</strong> Each row is a condition that shares clinical interventions with <em>{results.condition}</em>.
            The bar shows how many distinct interventions overlap — higher = stronger therapeutic adjacency.
          </div>

          <div className="kg-adjacency-list">
            {results.adjacent.map((c, i) => (
              <div key={i} className="kg-adj-row">
                <div className="kg-adj-name" title={c.condition}>{c.condition}</div>
                <div className="kg-adj-bar-wrap">
                  <div
                    className="kg-adj-bar"
                    style={{ width: `${Math.max(4, (c.shared_interventions / maxWeight) * 100)}%` }}
                  />
                </div>
                <div className="kg-adj-count">
                  <span className="kg-adj-interventions">{c.shared_interventions.toLocaleString()}</span>
                  <span className="kg-adj-label"> shared interventions</span>
                </div>
                {c.example_drugs?.length > 0 && (
                  <div className="kg-adj-trials" title={c.example_drugs.join(", ")}>
                    <span className="kg-adj-label">e.g. </span>{c.example_drugs[0]}{c.example_drugs.length > 1 ? `…` : ""}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sponsor Network ───────────────────────────────────────────────────────

function SponsorNetwork() {
  const [sponsor, setSponsor] = useState("");
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function search(e) {
    e.preventDefault();
    if (!sponsor.trim()) return;
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const data = await graphFetch("sponsor-network", { sponsor: sponsor.trim(), limit: 15 });
      setResults(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="kg-section">
      <div className="kg-section-header">
        <span className="kg-icon">◈</span>
        <div>
          <h3>Sponsor Network</h3>
          <p>A sponsor's therapeutic footprint and top conditions by trial count</p>
        </div>
      </div>

      <form className="kg-search-form" onSubmit={search}>
        <input
          type="text"
          className="kg-input"
          placeholder="e.g., Pfizer, Novartis, National Cancer Institute"
          value={sponsor}
          onChange={e => setSponsor(e.target.value)}
        />
        <button type="submit" className="kg-btn" disabled={loading || !sponsor.trim()}>
          {loading ? "Searching…" : "Traverse →"}
        </button>
      </form>

      {error && <div className="kg-error">⚠ {error}</div>}

      {results && (
        <div className="kg-results">
          <div className="kg-results-meta">
            <span className="kg-badge-purple">{sponsor}</span>
            {results.trial_count > 0 && <span className="kg-meta-text">{results.trial_count.toLocaleString()} total trials</span>}
          </div>

          <div className="kg-two-col">
            <div className="kg-col">
              <h4 className="kg-col-title">Top Conditions</h4>
              {results.conditions?.map((c, i) => (
                <div key={i} className="kg-list-row">
                  <span className="kg-list-rank">{i + 1}</span>
                  <span className="kg-list-name">{c.condition}</span>
                  <span className="kg-list-count">{c.trials?.toLocaleString()}</span>
                </div>
              ))}
            </div>

            <div className="kg-col">
              <h4 className="kg-col-title">Top Interventions</h4>
              {results.interventions?.map((c, i) => (
                <div key={i} className="kg-list-row">
                  <span className="kg-list-rank">{i + 1}</span>
                  <span className="kg-list-name">{c.intervention}</span>
                  <span className="kg-list-count">{c.trials?.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>

          {results.competitors?.length > 0 && (
            <div className="kg-competitor-section">
              <h4 className="kg-col-title">Competitor Overlap <span className="kg-chip">(sponsors sharing sites — available after full reload)</span></h4>
              {results.competitors.map((c, i) => (
                <div key={i} className="kg-list-row">
                  <span className="kg-list-rank">{i + 1}</span>
                  <span className="kg-list-name">{c.competitor}</span>
                  <span className="kg-list-count">{c.shared_sites} shared sites · {c.competitor_trials?.toLocaleString()} trials</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Graph Stats ───────────────────────────────────────────────────────────

function GraphStats({ stats, statsLoading }) {
  if (statsLoading) return <div className="kg-loading-line">Loading graph stats…</div>;
  if (!stats) return null;

  const nodeEntries = Object.entries(stats.nodes || {});
  const edgeEntries = Object.entries(stats.edges || {});
  const totalNodes = nodeEntries.reduce((s, [, v]) => s + v, 0);
  const totalEdges = edgeEntries.reduce((s, [, v]) => s + v, 0);

  return (
    <div className="kg-stats-bar">
      <span className="kg-stats-label">Graph:</span>
      {nodeEntries.map(([k, v]) => (
        <span key={k} className="kg-stat-pill kg-pill-node">{v.toLocaleString()} {k}</span>
      ))}
      <span className="kg-stats-sep">|</span>
      {edgeEntries.map(([k, v]) => (
        <span key={k} className="kg-stat-pill kg-pill-edge">{v.toLocaleString()} {k}</span>
      ))}
      <span className="kg-stats-total">{totalNodes.toLocaleString()} nodes · {totalEdges.toLocaleString()} edges</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// INLINE CONTEXT COMPONENTS — driven by active dashboard filters
// ═══════════════════════════════════════════════════════════════════════════

// ── 1. Strategic Gap Analysis (missing-edge detection) ────────────────────
// Pattern: Sponsor -RUNS-> Trial -TREATS-> MyCondition <-TREATS- OtherTrial -TREATS-> GapCondition
// GapCondition is NOT in the sponsor's portfolio. Truly graph-native: anti-join on missing edges.

function StrategicGapsInline({ sponsor }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setData(null);
    setLoading(true);
    graphFetch("strategic-gaps", { sponsor, limit: 12 })
      .then(d => setData(Array.isArray(d) ? d : []))
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [sponsor]);

  const maxStrength = data?.[0]?.adjacency_strength ?? 1;

  return (
    <div className="kg-context-entity">
      <div className="kg-context-entity-header">
        <span className="kg-icon" style={{ fontSize: "14px" }}>&#x26A0;</span>
        <span className="kg-context-entity-label">Portfolio gaps for</span>
        <span className="kg-badge-purple">{sponsor}</span>
      </div>
      <div className="kg-context-explain">
        Conditions therapeutically adjacent to {sponsor}&apos;s portfolio (shared drugs with existing conditions)
        where {sponsor} has <strong>zero trials</strong>. Expansion opportunities via missing-edge analysis.
      </div>

      {loading && <div className="kg-context-loading">Scanning missing edges in Sponsor &rarr; Trial &rarr; Condition graph&hellip;</div>}

      {data && data.length === 0 && !loading && (
        <div className="kg-context-empty">No strategic gaps detected.</div>
      )}

      {data && data.length > 0 && (
        <div className="kg-overlap-list">
          <div className="kg-overlap-header-row">
            <span>Gap condition</span>
            <span>Adjacency strength</span>
            <span>Connected via</span>
          </div>
          {data.map((c, i) => (
            <div key={i} className="kg-overlap-row">
              <div className="kg-overlap-name" title={c.condition}>
                <span className="kg-list-rank">{i + 1}</span>
                {c.condition}
              </div>
              <div className="kg-overlap-bar-wrap">
                <div
                  className="kg-overlap-bar kg-bar-amber"
                  style={{ width: `${Math.max(4, (c.adjacency_strength / maxStrength) * 100)}%` }}
                />
                <span className="kg-overlap-bar-label kg-label-amber">{c.adjacency_strength.toLocaleString()}</span>
              </div>
              <span className="kg-overlap-trials" title={c.via_conditions?.join(", ")}>
                {c.via_conditions?.slice(0, 2).join(", ")}{c.via_conditions?.length > 2 ? "\u2026" : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 2. Competitive Site Overlap (Sponsor &rarr; Trial &rarr; Site &larr; Trial &larr; Sponsor) ──

function SponsorOverlapInline({ sponsor }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setData(null);
    setLoading(true);
    graphFetch("sponsor-overlap", { sponsor, limit: 12 })
      .then(d => setData(Array.isArray(d) ? d : []))
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [sponsor]);

  const maxSites = data?.[0]?.shared_sites ?? 1;

  return (
    <div className="kg-context-entity">
      <div className="kg-context-entity-header">
        <span className="kg-icon" style={{ fontSize: "14px" }}>&#x25C8;</span>
        <span className="kg-context-entity-label">Site competitors of</span>
        <span className="kg-badge-purple">{sponsor}</span>
      </div>
      <div className="kg-context-explain">
        Sponsors co-located at the same trial sites &mdash; graph traversal impossible in SQL.
      </div>

      {loading && <div className="kg-context-loading">Traversing Sponsor &rarr; Trial &rarr; Site &rarr; Trial &rarr; Sponsor&hellip;</div>}

      {data && data.length === 0 && !loading && (
        <div className="kg-context-pending">
          <span className="kg-context-pending-icon">&#x23F3;</span>
          <div>
            <strong>Sites not yet in graph</strong>
            <p>Graph loader is hydrating 3.4M site nodes. Auto-populates once complete.</p>
          </div>
        </div>
      )}

      {data && data.length > 0 && (
        <div className="kg-overlap-list">
          <div className="kg-overlap-header-row">
            <span>Competitor sponsor</span>
            <span>Shared sites</span>
            <span>Their trials</span>
          </div>
          {data.map((c, i) => (
            <div key={i} className="kg-overlap-row">
              <div className="kg-overlap-name" title={c.sponsor}>
                <span className="kg-list-rank">{i + 1}</span>
                {c.sponsor}
              </div>
              <div className="kg-overlap-bar-wrap">
                <div className="kg-overlap-bar" style={{ width: `${Math.max(4, (c.shared_sites / maxSites) * 100)}%` }} />
                <span className="kg-overlap-bar-label">{c.shared_sites.toLocaleString()}</span>
              </div>
              <span className="kg-overlap-trials">{c.their_trials.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 3. Extended Competitive Landscape (condition filter, 3-hop traversal) ──
// Pattern: Condition <-TREATS- Trial -USES-> Intervention <-USES- Trial -TREATS-> AdjCondition
//          then: AdjCondition <-TREATS- Trial <-RUNS- Sponsor

function ConditionLandscapeInline({ condition }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setData(null);
    setLoading(true);
    graphFetch("condition-landscape", { condition, limit: 12 })
      .then(d => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [condition]);

  return (
    <div className="kg-context-entity">
      <div className="kg-context-entity-header">
        <span className="kg-icon" style={{ fontSize: "14px" }}>&#x1F310;</span>
        <span className="kg-context-entity-label">Competitive landscape for</span>
        <span className="kg-badge-teal">{condition}</span>
      </div>
      <div className="kg-context-explain">
        Sponsors most active across conditions that share clinical interventions with <strong>{condition}</strong> &mdash;
        3-hop graph traversal: Condition &rarr; Intervention &rarr; Adjacent Condition &rarr; Sponsor.
      </div>

      {loading && <div className="kg-context-loading">Traversing condition adjacency network&hellip;</div>}

      {data && data.landscape_sponsors?.length > 0 && (
        <div className="kg-overlap-list">
          <div className="kg-overlap-header-row">
            <span>Sponsor</span>
            <span>Adjacent conditions covered</span>
            <span>Trials</span>
          </div>
          {data.landscape_sponsors.map((s, i) => (
            <div key={i} className="kg-overlap-row">
              <div className="kg-overlap-name" title={s.sponsor}>
                <span className="kg-list-rank">{i + 1}</span>
                {s.sponsor}
              </div>
              <div className="kg-overlap-bar-wrap">
                <div
                  className="kg-overlap-bar kg-bar-teal"
                  style={{ width: `${Math.max(4, (s.adjacent_conditions / (data.landscape_sponsors[0]?.adjacent_conditions ?? 1)) * 100)}%` }}
                />
                <span className="kg-overlap-bar-label kg-label-teal">{s.adjacent_conditions}</span>
              </div>
              <span className="kg-overlap-trials">{s.trials.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}

      {data && (!data.landscape_sponsors || data.landscape_sponsors.length === 0) && !loading && (
        <div className="kg-context-empty">No extended landscape data for this condition.</div>
      )}
    </div>
  );
}

// ── 4. Drug Repurposing Paths (shortestPath — impossible in SQL) ──────────
// Fires when 2+ condition filters are active. Shows the shortest chain through
// the trial-intervention network connecting two conditions.

function RepurposingPathInline({ from, to }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setData(null);
    setLoading(true);
    graphFetch("repurposing-path", { from, to })
      .then(d => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [from, to]);

  const LABEL_COLORS = {
    Condition: "#39d2c0", Trial: "#8b949e", Intervention: "#a78bfa",
    Sponsor: "#f0883e", Site: "#58a6ff", Country: "#7ee787",
  };

  return (
    <div className="kg-context-entity">
      <div className="kg-context-entity-header">
        <span className="kg-icon" style={{ fontSize: "14px" }}>&#x2194;</span>
        <span className="kg-context-entity-label">Path:</span>
        <span className="kg-badge-teal">{from}</span>
        <span className="kg-context-entity-label">&rarr;</span>
        <span className="kg-badge-teal">{to}</span>
      </div>
      <div className="kg-context-explain">
        Shortest path between two conditions through the trial-intervention network.
        Uses Neo4j <code>shortestPath</code> &mdash; impossible to express in SQL.
      </div>

      {loading && <div className="kg-context-loading">Computing shortest path&hellip;</div>}

      {data && data.hops === -1 && !loading && (
        <div className="kg-context-empty">No path found between these conditions.</div>
      )}

      {data && data.hops > 0 && (
        <div className="kg-path-viz">
          <div className="kg-path-hops">{data.hops} hops</div>
          <div className="kg-path-chain">
            {data.path.map((node, i) => (
              <span key={i} className="kg-path-node-group">
                <span
                  className="kg-path-node"
                  style={{ borderColor: LABEL_COLORS[node.label] || "#484f58" }}
                  title={`${node.label}: ${node.name}`}
                >
                  <span className="kg-path-type" style={{ color: LABEL_COLORS[node.label] || "#484f58" }}>{node.label}</span>
                  <span className="kg-path-name">{node.name}</span>
                </span>
                {i < data.path.length - 1 && (
                  <span className="kg-path-edge">{data.edges[i]}</span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// KGContextPanel — inline in dashboard, driven by active filters
// ═══════════════════════════════════════════════════════════════════════════

export function KGContextPanel({ conditions = [], sponsors = [] }) {
  if (conditions.length === 0 && sponsors.length === 0) return null;

  const showPath = conditions.length >= 2;

  return (
    <div className="kg-context-panel">
      <div className="kg-context-header">
        <span className="kg-context-logo">&#x2B21;</span>
        <span className="kg-context-title">Graph Intelligence</span>
        <span className="kg-context-hint">queries that SQL can&apos;t answer &mdash; driven by your active filters</span>
      </div>
      <div className="kg-context-body">
        {sponsors.map(s => (
          <div key={s} className="kg-context-sponsor-group">
            <StrategicGapsInline sponsor={s} />
            <SponsorOverlapInline sponsor={s} />
          </div>
        ))}
        {conditions.map(c => <ConditionLandscapeInline key={c} condition={c} />)}
        {showPath && <RepurposingPathInline from={conditions[0]} to={conditions[1]} />}
      </div>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────

export default function GraphIntelligence({ stats, statsLoading }) {
  const [activeView, setActiveView] = useState("adjacency");

  return (
    <div className="kg-intelligence">
      <div className="kg-header">
        <div className="kg-header-left">
          <span className="kg-logo">⬡</span>
          <div>
            <h2 className="kg-title">Knowledge Graph Intelligence</h2>
            <p className="kg-subtitle">Graph traversal queries — impossible in relational SQL</p>
          </div>
        </div>
        <GraphStats stats={stats} statsLoading={statsLoading} />
      </div>

      <div className="kg-tabs">
        <button
          className={`kg-tab${activeView === "adjacency" ? " active" : ""}`}
          onClick={() => setActiveView("adjacency")}
        >
          Therapeutic Adjacency
        </button>
        <button
          className={`kg-tab${activeView === "sponsor" ? " active" : ""}`}
          onClick={() => setActiveView("sponsor")}
        >
          Sponsor Network
        </button>
        <span className="kg-tab-soon">Site Overlap <span className="kg-chip">after reload</span></span>
      </div>

      {activeView === "adjacency" && <TherapeuticAdjacency />}
      {activeView === "sponsor" && <SponsorNetwork />}
    </div>
  );
}
