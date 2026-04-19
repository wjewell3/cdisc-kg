import { useState, useCallback } from "react";

const LABEL_COLORS = {
  Condition: "#39d2c0", Trial: "#8b949e", Intervention: "#a78bfa",
  Sponsor: "#f0883e", Site: "#58a6ff", Country: "#7ee787",
};

const KG_QUESTIONS = [
  {
    id: "kq3",
    label: "Therapeutic Clusters",
    question: "Which conditions share drug pipelines?",
    description: "Finds clusters of conditions that are treated by the same drugs — they emerge naturally from the data, not from pre-defined categories.",
    endpoint: "communities",
    params: { min_shared: "3", limit: "20" },
  },
  {
    id: "kq4",
    label: "Sponsor Completion Rates",
    question: "Which sponsors have the best completion rates?",
    description: "Completion rates computed by following sponsor → trial relationships in the knowledge graph.",
    endpoint: "sponsor-completion",
    params: { min_trials: "20", limit: "20" },
  },
];

// Inline entity-input launchers — strategic questions that require a specific entity
const ENTITY_QUESTIONS = [
  {
    id: "eq1",
    label: "Strategic Gaps",
    icon: "🎯",
    placeholder: "Enter sponsor (e.g. Pfizer)",
    hint: "Conditions the sponsor doesn't cover but competitors do — white-space analysis for roadmap planning.",
    paramKey: "sponsor",
    endpoint: "strategic-gaps",
    extraParams: { limit: "10" },
  },
  {
    id: "eq2",
    label: "Competitive Landscape",
    icon: "🏗️",
    placeholder: "Enter condition (e.g. Diabetes)",
    hint: "Active sponsors and adjacent conditions in a therapeutic area — partnership and sourcing signals.",
    paramKey: "condition",
    endpoint: "condition-landscape",
    extraParams: { limit: "10" },
  },
  {
    id: "eq3",
    label: "Sponsor Portfolio",
    icon: "📋",
    placeholder: "Enter sponsor (e.g. Novartis)",
    hint: "Full research footprint — conditions, interventions, and trial count for vendor assessment.",
    paramKey: "sponsor",
    endpoint: "sponsor-network",
    extraParams: { limit: "15" },
  },
];

function trialsApiBase() {
  return import.meta.env.VITE_TRIALS_API_BASE || "";
}

export default function StrategicKGQuestions() {
  const [active, setActive] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Path explorer state
  const [pathFrom, setPathFrom] = useState("");
  const [pathTo, setPathTo] = useState("");
  const [pathData, setPathData] = useState(null);
  const [pathLoading, setPathLoading] = useState(false);
  const [pathError, setPathError] = useState(null);

  // Entity question state
  const [entityInputs, setEntityInputs] = useState({});
  const [entityData, setEntityData] = useState(null);
  const [entityLoading, setEntityLoading] = useState(false);
  const [entityError, setEntityError] = useState(null);

  const runQuestion = async (q) => {
    if (loading) return;
    setActive(q.id);
    setLoading(true);
    setError(null);
    setData(null);
    setEntityData(null);
    setPathData(null);

    try {
      const base = trialsApiBase();
      const params = new URLSearchParams(q.params);
      const url = base
        ? `${base}/api/graph/${q.endpoint}?${params}`
        : `/api/graph?path=${q.endpoint}&${params}`;
      const r = await fetch(url);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed");
      setData({ question: q, result: d });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const runPath = async (e) => {
    e.preventDefault();
    if (!pathFrom.trim() || !pathTo.trim() || pathLoading) return;
    setActive("path");
    setPathLoading(true);
    setPathError(null);
    setPathData(null);
    setData(null);
    setEntityData(null);

    try {
      const base = trialsApiBase();
      const url = base
        ? `${base}/api/graph/repurposing-path?from=${encodeURIComponent(pathFrom.trim())}&to=${encodeURIComponent(pathTo.trim())}`
        : `/api/graph?path=repurposing-path&from=${encodeURIComponent(pathFrom.trim())}&to=${encodeURIComponent(pathTo.trim())}`;
      const r = await fetch(url);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed");
      setPathData(d);
    } catch (e) {
      setPathError(e.message);
    } finally {
      setPathLoading(false);
    }
  };

  const runEntityQuestion = useCallback(async (eq) => {
    const val = (entityInputs[eq.id] || "").trim();
    if (!val || entityLoading) return;
    setActive(eq.id);
    setEntityLoading(true);
    setEntityError(null);
    setEntityData(null);
    setData(null);
    setPathData(null);

    try {
      const base = trialsApiBase();
      const params = new URLSearchParams({ [eq.paramKey]: val, ...eq.extraParams });
      const url = base
        ? `${base}/api/graph/${eq.endpoint}?${params}`
        : `/api/graph?path=${eq.endpoint}&${params}`;
      const r = await fetch(url);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed");
      setEntityData({ question: eq, input: val, result: d });
    } catch (e) {
      setEntityError(e.message);
    } finally {
      setEntityLoading(false);
    }
  }, [entityInputs, entityLoading]);

  return (
    <div className="skg-section">
      <div className="skg-header">
        <span className="skg-badge">KG</span>
        <span className="skg-title">Strategic Questions</span>
        <span className="skg-subtitle">Questions answered by traversing relationships between trials, sponsors, conditions, and interventions</span>
      </div>

      <div className="skg-buttons">
        {KG_QUESTIONS.map((q) => (
          <button
            key={q.id}
            className={`skg-btn${active === q.id ? " skg-btn-active" : ""}`}
            onClick={() => runQuestion(q)}
            title={q.description}
          >
            <span className="skg-btn-label">{q.label}</span>
            <span className="skg-btn-desc">{q.question}</span>
          </button>
        ))}
      </div>

      {/* ── Path Explorer — the path IS the insight ──────────────── */}
      <div className="skg-path-explorer">
        <form className="skg-path-form" onSubmit={runPath}>
          <span className="skg-path-icon">⤳</span>
          <input
            className="skg-path-input"
            placeholder="From condition (e.g. Alzheimer Disease)"
            value={pathFrom}
            onChange={e => setPathFrom(e.target.value)}
          />
          <span className="skg-path-arrow">→</span>
          <input
            className="skg-path-input"
            placeholder="To condition (e.g. Breast Cancer)"
            value={pathTo}
            onChange={e => setPathTo(e.target.value)}
          />
          <button className="skg-path-go" type="submit" disabled={!pathFrom.trim() || !pathTo.trim() || pathLoading}>
            Find Path
          </button>
        </form>
        <div className="skg-path-hint">
          Finds the shortest chain of relationships connecting two conditions — shows <em>what trials and drugs link them</em>.
          Spelling must be exact (e.g. &quot;Alzheimer Disease&quot;, not &quot;Alzheimer&apos;s&quot;).
        </div>
      </div>

      {/* ── Entity-input launchers ──────────────────────────── */}
      <div className="skg-entity-launchers">
        {ENTITY_QUESTIONS.map((eq) => (
          <div key={eq.id} className={`skg-entity-launcher${active === eq.id ? " skg-entity-active" : ""}`}>
            <div className="skg-entity-launcher-header">
              <span className="skg-entity-icon">{eq.icon}</span>
              <span className="skg-entity-label">{eq.label}</span>
            </div>
            <form className="skg-entity-form" onSubmit={(e) => { e.preventDefault(); runEntityQuestion(eq); }}>
              <input
                className="skg-path-input"
                placeholder={eq.placeholder}
                value={entityInputs[eq.id] || ""}
                onChange={(e) => setEntityInputs(prev => ({ ...prev, [eq.id]: e.target.value }))}
              />
              <button className="skg-path-go" type="submit" disabled={!(entityInputs[eq.id] || "").trim() || entityLoading}>
                Go
              </button>
            </form>
            <div className="skg-entity-hint">{eq.hint}</div>
          </div>
        ))}
      </div>

      {(loading || pathLoading || entityLoading) && (
        <div className="skg-loading">
          <div className="loading-spinner" style={{ width: 20, height: 20 }} />
          <span>Traversing knowledge graph…</span>
        </div>
      )}

      {(error || pathError || entityError) && <div className="skg-error">⚠ {error || pathError || entityError}</div>}

      {/* Path result */}
      {pathData && !pathLoading && <PathResult data={pathData} from={pathFrom} to={pathTo} />}

      {/* Entity question results */}
      {entityData && !entityLoading && <EntityResult data={entityData} />}

      {/* Other results */}
      {data && !loading && <SKGResult data={data} />}
    </div>
  );
}

// ── Path narrative visualization ────────────────────────────────────────
function PathResult({ data, from, to }) {
  if (data.hops === -1) {
    return (
      <div className="skg-result">
        <div className="skg-result-title">⤳ No path found</div>
        <div className="skg-path-hint">No graph walk connects "{from}" and "{to}" through the trial-intervention network.</div>
      </div>
    );
  }

  return (
    <div className="skg-result">
      <div className="skg-result-title">
        ⤳ Path: {from} → {to}
        <span className="skg-path-hops">{data.hops} hops</span>
      </div>
      <div className="skg-result-subtitle">
        Each node is a real entity in the knowledge graph. The path explains the connection.
      </div>

      <div className="skg-path-chain">
        {data.path.map((node, i) => (
          <span key={i} className="skg-path-node-group">
            <span
              className="skg-path-node"
              style={{ borderColor: LABEL_COLORS[node.label] || "#484f58" }}
            >
              <span className="skg-path-type" style={{ color: LABEL_COLORS[node.label] || "#484f58" }}>{node.label}</span>
              <span className="skg-path-name" title={node.name}>
                {node.name.length > 30 ? node.name.slice(0, 28) + "…" : node.name}
              </span>
            </span>
            {i < data.path.length - 1 && (
              <span className="skg-path-edge">{data.edges[i]}</span>
            )}
          </span>
        ))}
      </div>

      <div className="skg-path-narrative">
        {data.path.map((node, i) => {
          if (i === 0) return null;
          const prev = data.path[i - 1];
          const edge = data.edges[i - 1];
          return (
            <span key={i} className="skg-narrative-step">
              <strong>{prev.name}</strong>
              <span className="skg-narrative-edge"> —{edge}→ </span>
              <strong>{node.name}</strong>
              {i < data.path.length - 1 ? " · " : ""}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ── Entity question result renderers ─────────────────────────────────────
function EntityResult({ data }) {
  const { question, input, result } = data;

  // Strategic Gaps — array of { condition, adjacency_strength, via_conditions }
  if (question.endpoint === "strategic-gaps" && Array.isArray(result)) {
    if (result.length === 0) return <div className="skg-result"><div className="skg-result-title">🎯 No gaps found for "{input}"</div></div>;
    const maxStrength = Math.max(...result.map(r => r.adjacency_strength));
    return (
      <div className="skg-result">
        <div className="skg-result-title">🎯 Strategic Gaps for {input}</div>
        <div className="skg-result-subtitle">Conditions this sponsor doesn't cover but competitors do — ranked by adjacency strength</div>
        <div className="skg-result-body">
          {result.map((item, i) => (
            <div key={i} className="skg-row">
              <span className="skg-rank">{i + 1}</span>
              <span className="skg-entity" title={item.condition}>{item.condition}</span>
              <div className="skg-bar-track">
                <div className="skg-bar-fill" style={{ width: `${Math.max((item.adjacency_strength / maxStrength) * 100, 3)}%`, background: "#d29922" }} />
              </div>
              <span className="skg-metric">{item.adjacency_strength.toLocaleString()} adjacent trials</span>
              <span className="skg-metric-sub">via {item.via_conditions?.slice(0, 3).join(", ")}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Competitive Landscape — { condition, adjacent_conditions, landscape_sponsors }
  if (question.endpoint === "condition-landscape" && result.condition) {
    return (
      <div className="skg-result">
        <div className="skg-result-title">🏗️ Competitive Landscape: {result.condition}</div>
        <div className="skg-result-subtitle">Active sponsors and adjacent therapeutic areas</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <div className="skg-cluster-label" style={{ marginBottom: 8 }}>Adjacent Conditions (shared drugs)</div>
            {(result.adjacent_conditions || []).map((c, i) => (
              <div key={i} className="skg-row" style={{ padding: "3px 0" }}>
                <span className="skg-rank">{i + 1}</span>
                <span className="skg-entity">{c.condition}</span>
                <span className="skg-metric">{c.shared_drugs} shared</span>
              </div>
            ))}
          </div>
          <div>
            <div className="skg-cluster-label" style={{ marginBottom: 8 }}>Top Sponsors in Area</div>
            {(result.landscape_sponsors || []).map((s, i) => (
              <div key={i} className="skg-row" style={{ padding: "3px 0" }}>
                <span className="skg-rank">{i + 1}</span>
                <span className="skg-entity">{s.sponsor?.length > 28 ? s.sponsor.slice(0, 26) + "…" : s.sponsor}</span>
                <span className="skg-metric">{s.trials} trials</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Sponsor Portfolio — { trial_count, conditions, interventions, competitors }
  if (question.endpoint === "sponsor-network" && result.trial_count != null) {
    return (
      <div className="skg-result">
        <div className="skg-result-title">📋 Portfolio: {input}</div>
        <div className="skg-result-subtitle">{result.trial_count.toLocaleString()} total trials</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <div className="skg-cluster-label" style={{ marginBottom: 8 }}>Top Conditions</div>
            {(result.conditions || []).slice(0, 10).map((c, i) => (
              <div key={i} className="skg-row" style={{ padding: "3px 0" }}>
                <span className="skg-rank">{i + 1}</span>
                <span className="skg-entity">{c.condition}</span>
                <span className="skg-metric">{c.trials} trials</span>
              </div>
            ))}
          </div>
          <div>
            <div className="skg-cluster-label" style={{ marginBottom: 8 }}>Top Interventions</div>
            {(result.interventions || []).slice(0, 10).map((iv, i) => (
              <div key={i} className="skg-row" style={{ padding: "3px 0" }}>
                <span className="skg-rank">{i + 1}</span>
                <span className="skg-entity">{iv.intervention}</span>
                <span className="skg-metric">{iv.trials} trials</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return <div className="skg-result"><pre style={{ fontSize: 11, color: "#8b949e" }}>{JSON.stringify(result, null, 2)}</pre></div>;
}

// ── Result renderers ────────────────────────────────────────────────────
function SKGResult({ data }) {
  const { question, result } = data;

  if (question.endpoint === "communities" && result.communities) {
    return (
      <div className="skg-result">
        <div className="skg-result-title">🧩 {question.question}</div>
        <div className="skg-result-subtitle">{result.description}</div>
        <div className="skg-result-algo">Source: knowledge graph — conditions clustered by shared treatments</div>
        <div className="skg-result-subtitle">
          {result.total_conditions} conditions → {result.total_communities} clusters (min {result.min_shared_interventions} shared interventions)
        </div>
        <div className="skg-clusters">
          {result.communities.map((cluster, ci) => (
            <div key={ci} className="skg-cluster">
              <div className="skg-cluster-header">
                <span className="skg-cluster-label">Cluster #{ci + 1}</span>
                <span className="skg-cluster-count">
                  {cluster.size} conditions · {cluster.total_trials.toLocaleString()} trials
                </span>
              </div>
              <div className="skg-cluster-items">
                {cluster.conditions.slice(0, 6).map((c, i) => (
                  <span key={i} className="skg-cluster-pill">
                    {c.name.length > 30 ? c.name.slice(0, 28) + "…" : c.name}
                    <span className="skg-cluster-pill-count">{c.trials.toLocaleString()}</span>
                  </span>
                ))}
                {cluster.conditions.length > 6 && (
                  <span className="skg-cluster-more">+{cluster.conditions.length - 6} more</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (question.endpoint === "sponsor-completion" && result.items) {
    return (
      <div className="skg-result">
        <div className="skg-result-title">🏢 {question.question}</div>
        <div className="skg-result-subtitle">{result.description}</div>
        <div className="skg-result-algo">Source: knowledge graph (not SQL)</div>
        <div className="skg-result-body">
          <div className="skg-sponsor-table">
            <div className="skg-sponsor-header">
              <span>Sponsor</span><span>Total</span><span>Completed</span><span>Rate</span><span>Failed</span>
            </div>
            {result.items.map((item, i) => (
              <div key={i} className="skg-sponsor-row">
                <span className="skg-entity" title={item.sponsor}>
                  {item.sponsor.length > 30 ? item.sponsor.slice(0, 28) + "…" : item.sponsor}
                </span>
                <span className="skg-metric">{item.total}</span>
                <span className="skg-metric">{item.completed}</span>
                <span className="skg-metric" style={{ color: item.completion_pct >= 50 ? "#58a6ff" : "#d29922" }}>
                  {item.completion_pct}%
                </span>
                <span className="skg-metric" style={{ color: item.failure_pct > 20 ? "#d29922" : "#8b949e" }}>
                  {item.failure_pct}%
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return <div className="skg-result"><pre style={{ fontSize: 11, color: "#8b949e" }}>{JSON.stringify(result, null, 2)}</pre></div>;
}
