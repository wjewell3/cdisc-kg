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

// ── Adjacency Inline (auto-populates from active dashboard filter) ─────────

function AdjacencyInline({ condition }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setData(null);
    setLoading(true);
    graphFetch("therapeutic-adjacency", { condition, limit: 12 })
      .then(d => setData(Array.isArray(d) ? d : []))
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [condition]);

  const maxWeight = data?.[0]?.shared_interventions ?? 1;

  return (
    <div className="kg-context-entity">
      <div className="kg-context-entity-header">
        <span className="kg-icon" style={{ fontSize: "14px" }}>&#x2b21;</span>
        <span className="kg-context-entity-label">Adjacent to</span>
        <span className="kg-badge-teal">{condition}</span>
      </div>
      {loading && <div className="kg-context-loading">Traversing graph…</div>}
      {data && data.length === 0 && !loading && (
        <div className="kg-context-empty">No adjacency data found in graph for this condition.</div>
      )}
      {data && data.length > 0 && (
        <div className="kg-adjacency-list">
          {data.map((c, i) => (
            <div key={i} className="kg-adj-row kg-adj-row-compact">
              <div className="kg-adj-name" title={c.condition}>{c.condition}</div>
              <div className="kg-adj-bar-wrap">
                <div className="kg-adj-bar" style={{ width: `${Math.max(4, (c.shared_interventions / maxWeight) * 100)}%` }} />
              </div>
              <div className="kg-adj-count">
                <span className="kg-adj-interventions">{c.shared_interventions.toLocaleString()}</span>
                <span className="kg-adj-label"> shared</span>
              </div>
              {c.example_drugs?.length > 0 && (
                <div className="kg-adj-trials" title={c.example_drugs.join(", ")}>
                  <span className="kg-adj-label">e.g. </span>{c.example_drugs[0]}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Sponsor Inline (auto-populates from active dashboard filter) ───────────

function SponsorInline({ sponsor }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setData(null);
    setLoading(true);
    graphFetch("sponsor-network", { sponsor, limit: 10 })
      .then(d => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [sponsor]);

  return (
    <div className="kg-context-entity">
      <div className="kg-context-entity-header">
        <span className="kg-icon" style={{ fontSize: "14px" }}>&#x25c8;</span>
        <span className="kg-context-entity-label">Network for</span>
        <span className="kg-badge-purple">{sponsor}</span>
        {data?.trial_count > 0 && (
          <span className="kg-context-trial-count">{data.trial_count.toLocaleString()} trials</span>
        )}
      </div>
      {loading && <div className="kg-context-loading">Traversing graph…</div>}
      {data && (
        <div className="kg-two-col">
          <div className="kg-col">
            <h4 className="kg-col-title">Top Conditions</h4>
            {(data.conditions || []).slice(0, 8).map((c, i) => (
              <div key={i} className="kg-list-row">
                <span className="kg-list-rank">{i + 1}</span>
                <span className="kg-list-name">{c.condition}</span>
                <span className="kg-list-count">{c.trials?.toLocaleString()}</span>
              </div>
            ))}
          </div>
          <div className="kg-col">
            <h4 className="kg-col-title">Top Interventions</h4>
            {(data.interventions || []).slice(0, 8).map((c, i) => (
              <div key={i} className="kg-list-row">
                <span className="kg-list-rank">{i + 1}</span>
                <span className="kg-list-name">{c.intervention}</span>
                <span className="kg-list-count">{c.trials?.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── KGContextPanel (contextual — driven by active dashboard filters) ──────

export function KGContextPanel({ conditions = [], sponsors = [] }) {
  if (conditions.length === 0 && sponsors.length === 0) return null;

  return (
    <div className="kg-context-panel">
      <div className="kg-context-header">
        <span className="kg-context-logo">&#x2b21;</span>
        <span className="kg-context-title">Graph Intelligence</span>
        <span className="kg-context-hint">auto-populated from your active filters</span>
      </div>
      <div className="kg-context-body">
        {conditions.map(c => <AdjacencyInline key={c} condition={c} />)}
        {sponsors.map(s => <SponsorInline key={s} sponsor={s} />)}
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
