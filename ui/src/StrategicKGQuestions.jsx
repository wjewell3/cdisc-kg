import { useState } from "react";

const KG_QUESTIONS = [
  {
    id: "kq1",
    label: "Hub Conditions",
    question: "Which conditions connect the most sponsors and interventions?",
    description: "Graph centrality — identifies therapeutic areas that bridge otherwise-separate research clusters",
    endpoint: "centrality",
    params: { type: "condition", limit: "15" },
  },
  {
    id: "kq2",
    label: "Hub Sponsors",
    question: "Which sponsors have the widest therapeutic reach?",
    description: "Graph centrality — sponsors with the most diverse condition × intervention portfolios",
    endpoint: "centrality",
    params: { type: "sponsor", limit: "15" },
  },
  {
    id: "kq3",
    label: "Condition Communities",
    question: "What therapeutic communities exist in the trial landscape?",
    description: "Community detection — conditions clustered by shared drug pipelines",
    endpoint: "communities",
    params: { limit: "40" },
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

  return (
    <div className="skg-section">
      <div className="skg-header">
        <span className="skg-badge">KG</span>
        <span className="skg-title">Strategic Graph Questions</span>
        <span className="skg-subtitle">One-click knowledge graph intelligence</span>
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

      {loading && (
        <div className="skg-loading">
          <div className="loading-spinner" style={{ width: 20, height: 20 }} />
          <span>Querying knowledge graph…</span>
        </div>
      )}

      {error && <div className="skg-error">⚠ {error}</div>}

      {data && !loading && <SKGResult data={data} />}
    </div>
  );
}

function SKGResult({ data }) {
  const { question, result } = data;

  if (question.endpoint === "centrality" && result.items) {
    const maxScore = Math.max(...result.items.map((i) => i.connectivity_score));
    return (
      <div className="skg-result">
        <div className="skg-result-title">
          {result.type === "condition" ? "🧬" : "🏢"} {question.question}
        </div>
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
                  style={{ width: `${Math.max((item.connectivity_score / maxScore) * 100, 2)}%` }}
                />
              </div>
              <span className="skg-metric">{item.trials.toLocaleString()} trials</span>
              <span className="skg-metric-sub">
                {result.type === "condition"
                  ? `${item.unique_sponsors} sponsors · ${item.unique_interventions} interventions`
                  : `${item.unique_conditions} conditions · ${item.unique_interventions} interventions`}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (question.endpoint === "communities" && result.clusters) {
    return (
      <div className="skg-result">
        <div className="skg-result-title">🧩 {question.question}</div>
        <div className="skg-result-subtitle">
          {result.total_conditions} conditions across {result.clusters.length} therapeutic clusters
        </div>
        <div className="skg-clusters">
          {result.clusters.map((cluster, ci) => (
            <div key={ci} className="skg-cluster">
              <div className="skg-cluster-header">
                <span className="skg-cluster-label">{cluster.cluster_label}</span>
                <span className="skg-cluster-count">{cluster.conditions.length} conditions</span>
              </div>
              <div className="skg-cluster-items">
                {cluster.conditions.slice(0, 5).map((c, i) => (
                  <span key={i} className="skg-cluster-pill">
                    {c.condition.length > 30 ? c.condition.slice(0, 28) + "…" : c.condition}
                    <span className="skg-cluster-pill-count">{c.trial_count.toLocaleString()}</span>
                  </span>
                ))}
                {cluster.conditions.length > 5 && (
                  <span className="skg-cluster-more">+{cluster.conditions.length - 5} more</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return <div className="skg-result"><pre>{JSON.stringify(result, null, 2)}</pre></div>;
}
