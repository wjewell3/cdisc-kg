import { useState, useCallback, useRef, useEffect } from "react";
import { executeConditionSearch } from "./trialsEngine";

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
    subtitle: "→ Conditions grouped by shared interventions",
    endpoint: "communities",
    params: { min_shared: "3", limit: "20" },
  },
  {
    id: "kq4",
    label: "Sponsor Completion Rates",
    question: "Which sponsors have the best completion rates?",
    description: "Completion rates computed by following sponsor → trial relationships in the knowledge graph.",
    subtitle: "→ Sponsor leaderboard by trial completion %",
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
    hint: "→ Conditions the sponsor doesn't cover but competitors do",
    paramKey: "sponsor",
    endpoint: "strategic-gaps",
    extraParams: { limit: "10" },
    examples: ["Pfizer", "Novartis", "Merck"],
  },
  {
    id: "eq2",
    label: "Competitive Landscape",
    icon: "🏗️",
    placeholder: "Enter condition (e.g. Diabetes)",
    hint: "→ Active sponsors and adjacent conditions in a therapeutic area",
    paramKey: "condition",
    endpoint: "condition-landscape",
    extraParams: { limit: "10" },
    examples: ["Breast Cancer", "Diabetes Mellitus", "Alzheimer Disease"],
  },
  {
    id: "eq3",
    label: "Sponsor Portfolio",
    icon: "📋",
    placeholder: "Enter sponsor (e.g. Novartis)",
    hint: "→ Full research footprint — conditions, interventions, trial count",
    paramKey: "sponsor",
    endpoint: "sponsor-network",
    extraParams: { limit: "15" },
    examples: ["Novartis", "GSK", "Roche"],
  },
];

function trialsApiBase() {
  return import.meta.env.VITE_TRIALS_API_BASE || "";
}

// ── Condition Typeahead (reused for path from/to) ────────────────────────────
function ConditionTypeahead({ value, onChange, placeholder }) {
  const [query, setQuery] = useState(value);
  const [suggestions, setSuggestions] = useState([]);
  const [popular, setPopular] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loadingPop, setLoadingPop] = useState(false);
  const debounceRef = useRef(null);
  const wrapRef = useRef(null);

  useEffect(() => { setQuery(value); }, [value]);

  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false); setActive(-1);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const fetchSuggestions = useCallback((q) => {
    clearTimeout(debounceRef.current);
    if (!q || q.length < 2) { setSuggestions([]); return; }
    debounceRef.current = setTimeout(async () => {
      const results = await executeConditionSearch({}, q);
      setSuggestions(results.slice(0, 12));
      setActive(-1);
    }, 250);
  }, []);

  const handleFocus = useCallback(async () => {
    setOpen(true);
    if (query.length >= 2) {
      const results = await executeConditionSearch({}, query);
      setSuggestions(results.slice(0, 12));
      setActive(-1);
    } else if (popular.length === 0 && !loadingPop) {
      setLoadingPop(true);
      const results = await executeConditionSearch({}, "");
      setPopular(results.slice(0, 12));
      setLoadingPop(false);
    }
  }, [popular, loadingPop, query]);

  const handleClick = useCallback(async () => {
    if (!open) {
      setOpen(true);
      if (query.length >= 2) {
        const results = await executeConditionSearch({}, query);
        setSuggestions(results.slice(0, 12));
        setActive(-1);
      }
    }
  }, [open, query]);

  const handleChange = (e) => {
    const q = e.target.value;
    setQuery(q);
    onChange(q);
    fetchSuggestions(q);
  };

  const select = ([val]) => {
    setQuery(val);
    onChange(val);
    setSuggestions([]);
    setOpen(false);
    setActive(-1);
  };

  const displayed = query.length >= 2 ? suggestions : popular;

  const handleKeyDown = (e) => {
    if (!open || displayed.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(a => Math.min(a + 1, displayed.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(a => Math.max(a - 1, -1));
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      select(displayed[active]);
    } else if (e.key === "Escape") {
      setOpen(false); setActive(-1);
    }
  };

  return (
    <div className="skg-typeahead" ref={wrapRef} style={{ position: "relative", flex: 1 }}>
      <input
        className="skg-path-input"
        type="text"
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onClick={handleClick}
        placeholder={placeholder}
        autoComplete="off"
      />
      {open && displayed.length > 0 && (
        <ul className="skg-suggestions" style={{
          position: "absolute", top: "100%", left: 0, right: 0, zIndex: 100,
          background: "#161b22", border: "1px solid #30363d", borderRadius: 6,
          listStyle: "none", margin: "2px 0 0", padding: 0, maxHeight: 220, overflowY: "auto",
        }}>
          {query.length < 2 && (
            <li style={{ padding: "4px 10px", color: "#8b949e", fontSize: 11, fontWeight: 600 }}>Popular conditions</li>
          )}
          {displayed.map(([val, count], i) => (
            <li
              key={val}
              style={{
                padding: "6px 10px", cursor: "pointer", display: "flex", justifyContent: "space-between",
                background: i === active ? "#21262d" : "transparent", color: "#c9d1d9", fontSize: 13,
              }}
              onMouseDown={() => select([val, count])}
              onMouseEnter={() => setActive(i)}
            >
              <span>{val}</span>
              <span style={{ color: "#8b949e", fontSize: 11 }}>{count?.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function StrategicKGQuestions({ showOnly, hideHeader } = {}) {
  const [expanded, setExpanded] = useState(true);
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

  const runEntityQuestion = useCallback(async (eq, overrideVal) => {
    const val = (overrideVal || entityInputs[eq.id] || "").trim();
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

  const filteredKG = showOnly ? KG_QUESTIONS.filter(q => showOnly.includes(q.id)) : KG_QUESTIONS;
  const filteredEntity = showOnly ? ENTITY_QUESTIONS.filter(q => showOnly.includes(q.id)) : ENTITY_QUESTIONS;
  const showPath = !showOnly || showOnly.includes("path");

  return (
    <div className="skg-section">
      {!hideHeader && (
      <div className="skg-header skg-header-toggle" onClick={() => setExpanded(e => !e)} role="button" tabIndex={0} onKeyDown={e => e.key === "Enter" && setExpanded(x => !x)}>
        <span className="skg-badge">KG</span>
        <span className="skg-title">Knowledge Graph Exploration</span>
        <span className="skg-subtitle">Strategic questions powered by relationship traversal across trials, sponsors, conditions, and interventions</span>
        <span className={`skg-chevron${expanded ? " skg-chevron-open" : ""}`}>▸</span>
      </div>
      )}

      {expanded && (<>
      {filteredKG.length > 0 && (
      <div className="skg-buttons">
        {filteredKG.map((q) => (
          <button
            key={q.id}
            className={`skg-btn${active === q.id ? " skg-btn-active" : ""}`}
            onClick={() => runQuestion(q)}
            title={q.description}
          >
            <span className="skg-btn-label">{q.label}</span>
            <span className="skg-btn-desc">{q.question}</span>
            {q.subtitle && <span className="skg-btn-subtitle">{q.subtitle}</span>}
          </button>
        ))}
      </div>
      )}

      {/* ── Path Explorer — the path IS the insight ──────────────── */}
      {showPath && (
      <div className="skg-path-explorer">
        <form className="skg-path-form" onSubmit={runPath}>
          <span className="skg-path-icon">⤳</span>
          <ConditionTypeahead
            value={pathFrom}
            onChange={setPathFrom}
            placeholder="From condition (e.g. Alzheimer Disease)"
          />
          <span className="skg-path-arrow">→</span>
          <ConditionTypeahead
            value={pathTo}
            onChange={setPathTo}
            placeholder="To condition (e.g. Breast Cancer)"
          />
          <button className="skg-path-go" type="submit" disabled={!pathFrom.trim() || !pathTo.trim() || pathLoading}>
            Find Path
          </button>
        </form>
        <div className="skg-path-hint">
          Finds the shortest chain of relationships connecting two conditions — shows <em>what trials and drugs link them</em>.
        </div>
      </div>
      )}

      {/* ── Entity-input launchers ──────────────────────────── */}
      {filteredEntity.length > 0 && (
      <div className="skg-entity-launchers">
        {filteredEntity.map((eq) => (
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
            {eq.examples && (
              <div className="skg-entity-examples">
                {eq.examples.map(ex => (
                  <button key={ex} className="skg-entity-chip" onClick={() => {
                    setEntityInputs(prev => ({ ...prev, [eq.id]: ex }));
                    runEntityQuestion({ ...eq }, ex);
                  }}>
                    {ex}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      )}

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
      </>)}
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
