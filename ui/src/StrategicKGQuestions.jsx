import { useState } from "react";

const LABEL_COLORS = {
  Condition: "#39d2c0", Trial: "#8b949e", Intervention: "#a78bfa",
  Sponsor: "#f0883e", Site: "#58a6ff", Country: "#7ee787",
};

const KG_QUESTIONS = [
  {
    id: "kq1",
    label: "Hub Conditions",
    question: "Which conditions bridge the most sponsor programs?",
    description: "3-hop bridge score: Sponsor → Trial → Condition → Trial → different Sponsor. Cannot be replicated with SQL GROUP BY.",
    endpoint: "centrality",
    params: { type: "condition", limit: "15" },
  },
  {
    id: "kq2",
    label: "Hub Sponsors",
    question: "Which sponsors bridge the most therapeutic areas?",
    description: "3-hop bridge score: Condition → Trial → Sponsor → Trial → different Condition. Multi-hop graph reasoning.",
    endpoint: "centrality",
    params: { type: "sponsor", limit: "15" },
  },
  {
    id: "kq3",
    label: "Condition Communities",
    question: "What therapeutic communities emerge from the graph?",
    description: "Label propagation over condition-condition overlay graph (2-hop via shared interventions). Emergent structure, not predefined categories.",
    endpoint: "communities",
    params: { min_shared: "3", limit: "20" },
  },
  {
    id: "kq4",
    label: "Sponsor Completion (KG)",
    question: "Which sponsors have the best completion rates? (via graph traversal)",
    description: "Same insight as SQL leaderboard, but computed by traversing Sponsor → Trial edges in Neo4j. The KG is the semantic layer.",
    endpoint: "sponsor-completion",
    params: { min_trials: "20", limit: "20" },
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

  const runQuestion = async (q) => {
    if (loading) return;
    setActive(q.id);
    setLoading(true);
    setError(null);
    setData(null);

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

  return (
    <div className="skg-section">
      <div className="skg-header">
        <span className="skg-badge">KG</span>
        <span className="skg-title">Strategic Graph Questions</span>
        <span className="skg-subtitle">Questions only a knowledge graph can answer — multi-hop reasoning, emergent structure, path narratives</span>
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
          Finds the shortest graph walk between two conditions — the path narrative explains <em>why</em> they&apos;re connected.
          Uses Neo4j <code>shortestPath</code> — impossible in SQL.
        </div>
      </div>

      {(loading || pathLoading) && (
        <div className="skg-loading">
          <div className="loading-spinner" style={{ width: 20, height: 20 }} />
          <span>Traversing knowledge graph…</span>
        </div>
      )}

      {(error || pathError) && <div className="skg-error">⚠ {error || pathError}</div>}

      {/* Path result */}
      {pathData && !pathLoading && <PathResult data={pathData} from={pathFrom} to={pathTo} />}

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

// ── Result renderers ────────────────────────────────────────────────────
function SKGResult({ data }) {
  const { question, result } = data;

  if (question.endpoint === "centrality" && result.items) {
    const maxScore = Math.max(...result.items.map((i) => i.bridge_score));
    return (
      <div className="skg-result">
        <div className="skg-result-title">
          {result.type === "condition" ? "🧬" : "🏢"} {question.question}
        </div>
        <div className="skg-result-subtitle">{result.description}</div>
        <div className="skg-result-algo">Algorithm: {result.algorithm}</div>
        <div className="skg-result-body">
          {result.items.map((item, i) => (
            <div key={i} className="skg-row">
              <span className="skg-rank">{i + 1}</span>
              <span className="skg-entity" title={item.entity}>
                {item.entity.length > 35 ? item.entity.slice(0, 33) + "…" : item.entity}
              </span>
              <div className="skg-bar-track">
                <div
                  className="skg-bar-fill"
                  style={{ width: `${Math.max((item.bridge_score / maxScore) * 100, 2)}%` }}
                />
              </div>
              <span className="skg-metric">{item.bridge_score.toLocaleString()} bridges</span>
              <span className="skg-metric-sub">
                {item.trials.toLocaleString()} trials · {result.type === "condition"
                  ? `${item.sponsor_count} sponsors`
                  : `${item.condition_count} conditions`}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (question.endpoint === "communities" && result.communities) {
    return (
      <div className="skg-result">
        <div className="skg-result-title">🧩 {question.question}</div>
        <div className="skg-result-subtitle">{result.description}</div>
        <div className="skg-result-algo">Algorithm: {result.algorithm}</div>
        <div className="skg-result-subtitle">
          {result.total_conditions} conditions → {result.total_communities} emergent communities (min {result.min_shared_interventions} shared interventions)
        </div>
        <div className="skg-clusters">
          {result.communities.map((cluster, ci) => (
            <div key={ci} className="skg-cluster">
              <div className="skg-cluster-header">
                <span className="skg-cluster-label">Community #{ci + 1}</span>
                <span className="skg-cluster-count">
                  {cluster.size} conditions · {cluster.total_trials.toLocaleString()} trials · {cluster.internal_edges} internal edges
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
        <div className="skg-result-algo">Source: {result.source} (not SQL)</div>
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
