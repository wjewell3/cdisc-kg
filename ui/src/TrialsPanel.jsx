import { useState, useCallback, useMemo, useEffect } from "react";
import { resolveTrialQuery, executeTrialQuery, executeTrialAgg, TRIAL_QUERIES, FILTER_CATALOG } from "./trialsEngine";
import TrialsCharts from "./TrialsCharts";
import "./TrialsPanel.css";

const STATUS_CLASS = {
  RECRUITING: "status-recruiting",
  ACTIVE_NOT_RECRUITING: "status-active",
  COMPLETED: "status-completed",
  TERMINATED: "status-terminated",
  WITHDRAWN: "status-withdrawn",
  SUSPENDED: "status-suspended",
  ENROLLING_BY_INVITATION: "status-active",
  NOT_YET_RECRUITING: "status-pending",
};

const STATUS_LABEL = {
  RECRUITING: "Recruiting",
  ACTIVE_NOT_RECRUITING: "Active",
  COMPLETED: "Completed",
  TERMINATED: "Terminated",
  WITHDRAWN: "Withdrawn",
  SUSPENDED: "Suspended",
  ENROLLING_BY_INVITATION: "By Invitation",
  NOT_YET_RECRUITING: "Not Yet Open",
};

const PHASE_CLASS = {
  "Phase 1": "phase-1",
  "Phase 2": "phase-2",
  "Phase 3": "phase-3",
  "Phase 4": "phase-4",
  "Phase 1/Phase 2": "phase-12",
  "Phase 2/Phase 3": "phase-23",
  "N/A": "phase-na",
};

export default function TrialsPanel() {
  const [query, setQuery] = useState("");
  const [step, setStep] = useState("question"); // question | loading | results | error
  const [resolutions, setResolutions] = useState([]);
  const [results, setResults] = useState(null);
  const [selectedTrial, setSelectedTrial] = useState(null);
  const [error, setError] = useState(null);
  const [activeQuery, setActiveQuery] = useState("");
  const [chartFilters, setChartFilters] = useState([]); // [{ field, value }, ...]
  const [activeResolutions, setActiveResolutions] = useState([]);
  const [showFilterPicker, setShowFilterPicker] = useState(false);
  const [baseResults, setBaseResults] = useState(null);
  const [baseLoading, setBaseLoading] = useState(true);
  const [aggData, setAggData] = useState(null);
  const [displayCount, setDisplayCount] = useState(25);

  // Auto-load browse dataset + full-DB aggregates in parallel on mount
  useEffect(() => {
    Promise.all([
      executeTrialQuery({}, 500),
      executeTrialAgg({}),
    ]).then(([rows, agg]) => {
      setBaseResults(rows);
      setAggData(agg);
      setBaseLoading(false);
    }).catch(() => { setBaseLoading(false); });
  }, []);

  const rerunWithResolutions = useCallback(async (resols) => {
    setSelectedTrial(null);
    setChartFilters([]);
    setDisplayCount(25);
    const params = {};
    for (const r of resols) {
      if (r.value) {
        params[r.param] = params[r.param] ? `${params[r.param]},${r.value}` : r.value;
      }
    }
    try {
      const [data, agg] = await Promise.all([
        executeTrialQuery(params, 500),
        executeTrialAgg(params),
      ]);
      setResults(data);
      setAggData(agg);
      setStep(resols.length === 0 ? "question" : "results");
    } catch (err) {
      setError(err.message);
      setStep("error");
    }
  }, []);

  const removeResolution = useCallback((idx) => {
    setActiveResolutions((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      if (next.length === 0) {
        setStep("question");
        setResults(null);
        return [];
      }
      rerunWithResolutions(next);
      return next;
    });
  }, [rerunWithResolutions]);

  const toggleFilterOption = useCallback((param, value, label) => {
    setActiveResolutions((prev) => {
      const existingIdx = prev.findIndex((r) => r.param === param && r.value === value);
      let next;
      if (existingIdx !== -1) {
        // already selected — deselect
        next = prev.filter((_, i) => i !== existingIdx);
      } else {
        // add (multiple same-param entries allowed)
        next = [...prev, { param, value, label, kgPath: `${param} → ${value}` }];
      }
      if (next.length === 0) { setStep("question"); setResults(null); return []; }
      rerunWithResolutions(next);
      return next;
    });
  }, [rerunWithResolutions]);

  const runQuery = useCallback(async (text) => {
    setQuery(text);
    setActiveQuery(text);
    setSelectedTrial(null);
    setError(null);
    setStep("loading");
    setShowFilterPicker(false);
    setDisplayCount(25);

    const { params, resolutions: resolved } = resolveTrialQuery(text);
    setResolutions(resolved);
    setActiveResolutions(resolved);

    try {
      const [data, agg] = await Promise.all([
        executeTrialQuery(params, 500),
        executeTrialAgg(params),
      ]);
      setResults(data);
      setAggData(agg);
      setStep("results");
    } catch (err) {
      setError(err.message);
      setStep("error");
    }
  }, []);

  const handlePreset = useCallback((q) => runQuery(q.text), [runQuery]);

  const handleSubmit = useCallback(
    (e) => {
      e.preventDefault();
      if (query.trim()) runQuery(query);
    },
    [query, runQuery]
  );

  const filteredTrials = useMemo(() => {
    const source = results || baseResults;
    if (!source?.results) return [];
    if (chartFilters.length === 0) return source.results;
    const ENROLL_BUCKETS = {
      "< 100": [0, 99], "100–499": [100, 499], "500–999": [500, 999],
      "1k–4.9k": [1000, 4999], "5k–19k": [5000, 19999], "≥ 20k": [20000, Infinity],
    };
    const byField = {};
    for (const { field, value } of chartFilters) {
      if (!byField[field]) byField[field] = new Set();
      byField[field].add(value);
    }
    return source.results.filter((t) =>
      Object.entries(byField).every(([field, values]) => {
        if (field === "phase") return values.has(t.phase || "Unknown");
        if (field === "status") return values.has(t.status || "Unknown");
        if (field === "sponsor") return values.has(t.sponsor || "Unknown");
        if (field === "_enroll_range") {
          return [...values].some((v) => {
            const range = ENROLL_BUCKETS[v];
            return range && t.enrollment != null && t.enrollment >= range[0] && t.enrollment <= range[1];
          });
        }
        return true;
      })
    );
  }, [results, baseResults, chartFilters]);

  const handleChartFilter = useCallback((field, value) => {
    setSelectedTrial(null);
    if (field === null || value === null) {
      setChartFilters([]);
    } else {
      setChartFilters((prev) => {
        const exists = prev.some((f) => f.field === field && f.value === value);
        return exists
          ? prev.filter((f) => !(f.field === field && f.value === value))
          : [...prev, { field, value }];
      });
    }
  }, []);

  // Count how many current results match each filter option (for hiding empties)
  const filterOptionCounts = useMemo(() => {
    if (!results?.results) return {};
    const counts = {};
    for (const group of FILTER_CATALOG) {
      for (const opt of group.options) {
        const key = `${group.param}::${opt.value}`;
        counts[key] = results.results.filter((t) => {
          switch (group.param) {
            case "phase": return (t.phase || "") === opt.value;
            case "status": return (t.status || "") === opt.value;
            case "condition": return t.conditions?.toLowerCase().includes(opt.value.toLowerCase());
            case "intervention": return t.interventions?.toLowerCase().includes(opt.value.toLowerCase());
            case "sponsor": return t.sponsor?.toLowerCase().includes(opt.value.toLowerCase());
            default: return false;
          }
        }).length;
      }
    }
    return counts;
  }, [results]);

  const reset = useCallback(() => {
    setChartFilters([]);
    setResults(null);
    setSelectedTrial(null);
    setError(null);
    setActiveQuery("");
    setStep("question");
    setQuery("");
    setResolutions([]);
    setActiveResolutions([]);
    setShowFilterPicker(false);
    setDisplayCount(25);
    // Re-fetch base agg when resetting
    executeTrialAgg({}).then(setAggData).catch(() => {});
  }, []);

  return (
    <div className="trials-panel">
      {/* Header bar */}
      <div className="trials-header">
        <div className="trials-header-left">
          <div className="trials-logo">🌐</div>
          <div>
            <h1 className="trials-title">Cross-Trial Intelligence</h1>
            <p className="trials-subtitle">Live query across 500,000+ ClinicalTrials.gov studies via AACT</p>
          </div>
        </div>
        <div className="trials-badge-row">
          <span className="aact-badge">AACT Live DB</span>
          <span className="sdtm-badge">KG Semantic Layer</span>
        </div>
      </div>

      <div className="trials-body">
        {/* Search section — always compact so charts are the primary view */}
        <div className="trials-section compact-section">
          <div className="section-header">
            <div className="section-icon">💬</div>
            <h2>Ask a Cross-Trial Question</h2>
            {step !== "question" && (
              <button className="reset-btn" onClick={reset}>
                New Query
              </button>
            )}
          </div>
          {step === "question" ? (
            <form onSubmit={handleSubmit} className="query-form" style={{ margin: 0 }}>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder='e.g., "Phase 3 Alzheimer trials" or "Recruiting breast cancer immunotherapy"'
                className="query-input"
              />
              <button type="submit" className="query-submit" disabled={!query.trim()}>
                Search →
              </button>
            </form>
          ) : (
            <div className="compact-query">
              <span className="compact-q">"{activeQuery}"</span>
            </div>
          )}
          {/* Suggested queries — only while initial data is loading (1-2s) */}
          {step === "question" && baseLoading && (
            <div className="preset-section">
              <h3>Suggested queries:</h3>
              <div className="preset-grid">
                {TRIAL_QUERIES.map((q) => (
                  <button key={q.id} className="preset-card" onClick={() => handlePreset(q)}>
                    <span className="preset-text">"{q.text}"</span>
                    <span className="preset-desc">{q.description}</span>
                    <div className="preset-tags">
                      {q.tags.map((t) => (
                        <span key={t} className="preset-tag">{t}</span>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Chart filter pills in browse mode */}
        {step === "question" && chartFilters.length > 0 && (
          <div className="kg-params-bar">
            <span className="kg-params-label">🔍 Browse filters →</span>
            {chartFilters.map((cf, i) => (
              <React.Fragment key={i}>
                <span className="kg-param-pill kg-filter-pill">
                  <span className="kg-filter-icon">🔍</span>
                  <span>{cf.field.replace(/^_/, "").replace(/_LABEL$/, "")}</span>
                  <span className="kg-eq">=</span>
                  <span className="kg-val">{cf.value}</span>
                  <button className="kg-filter-clear" onClick={() => setChartFilters((prev) => prev.filter((_, j) => j !== i))} aria-label="Clear filter">×</button>
                </span>
              </React.Fragment>
            ))}
            <button className="kg-filter-clear" style={{marginLeft:"auto"}} onClick={() => setChartFilters([])}>Clear all ×</button>
          </div>
        )}

        {/* KG resolution — compact param bar */}
        {(step === "loading" || step === "results" || step === "error") && (activeResolutions.length > 0 || step === "results") && (
          <>
            <div className="kg-params-bar slide-in">
              <span className="kg-params-label">🔗 KG →</span>
              {activeResolutions.map((r, i) => (
                <span key={i} className="kg-param-pill kg-param-removable">
                  <code>{r.param}</code>
                  {r.value && <><span className="kg-eq">=</span><span className="kg-val">{r.value}</span></>}
                  <button className="kg-param-remove" onClick={() => removeResolution(i)} aria-label={`Remove ${r.param}`}>×</button>
                </span>
              ))}
              {chartFilters.map((cf, i) => (
                <React.Fragment key={i}>
                  <span className="kg-filter-sep">·</span>
                  <span className="kg-param-pill kg-filter-pill">
                    <span className="kg-filter-icon">🔍</span>
                    <span>{cf.field.replace(/^_/, "").replace(/_LABEL$/, "")}</span>
                    <span className="kg-eq">=</span>
                    <span className="kg-val">{cf.value}</span>
                    <button className="kg-filter-clear" onClick={() => setChartFilters((prev) => prev.filter((_, j) => j !== i))} aria-label="Clear filter">×</button>
                  </span>
                </React.Fragment>
              ))}
              <button
                className={`kg-add-filter-btn ${showFilterPicker ? "active" : ""}`}
                onClick={() => setShowFilterPicker((v) => !v)}
                aria-expanded={showFilterPicker}
              >
                {showFilterPicker ? "▲ Filters" : "+ Filters"}
              </button>
            </div>

            {showFilterPicker && (
              <div className="filter-picker slide-in">
                {FILTER_CATALOG.map((group) => {
                  const activeVals = new Set(
                    activeResolutions.filter((r) => r.param === group.param).map((r) => r.value)
                  );
                  const visibleOpts = group.options.filter((opt) => {
                    const count = filterOptionCounts[`${group.param}::${opt.value}`] ?? 0;
                    return activeVals.has(opt.value) || count > 0;
                  });
                  if (visibleOpts.length === 0) return null;
                  return (
                    <div key={group.param} className="filter-picker-group">
                      <span className="filter-picker-label">{group.label}:</span>
                      <div className="filter-picker-options">
                        {visibleOpts.map((opt) => {
                          const isActive = activeVals.has(opt.value);
                          return (
                            <button
                              key={opt.value}
                              className={`filter-picker-opt ${isActive ? "filter-opt-active" : ""}`}
                              onClick={() => toggleFilterOption(group.param, opt.value, opt.label)}
                            >
                              {opt.label}
                              {filterOptionCounts[`${group.param}::${opt.value}`] > 0 && (
                                <span className="filter-opt-count">({filterOptionCounts[`${group.param}::${opt.value}`]})</span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* Main content — always rendered; shows spinner until data arrives */}
        {step === "loading" ? (
          <div className="trials-section slide-in">
            <div className="loading-state">
              <div className="loading-spinner" />
              <p>Querying AACT live database…</p>
              <p className="loading-sub">aact-db.ctti-clinicaltrials.org</p>
            </div>
          </div>
        ) : step === "error" ? (
          <div className="trials-section slide-in">
            <div className="error-state">
              <div className="error-icon">⚠️</div>
              <p className="error-msg">
                {error?.includes("ECONNREFUSED") || error?.includes("connect")
                  ? "AACT database is temporarily unavailable (nightly refresh or maintenance). Please try again in a few minutes."
                  : `Query failed: ${error}`}
              </p>
              <button className="reset-btn" onClick={reset}>
                Try Again
              </button>
            </div>
          </div>
        ) : (
          <div className="trials-section slide-in">
            {baseLoading && !results ? (
              <div className="loading-state">
                <div className="loading-spinner" />
                <p>Loading trial data…</p>
                <p className="loading-sub">aact-db.ctti-clinicaltrials.org</p>
              </div>
            ) : !(results || baseResults) ? (
              <div className="no-results">Trial data unavailable — AACT database may be offline.</div>
            ) : (results || baseResults).total === 0 ? (
              <div className="no-results">
                {step === "results" ? "No trials found matching your query. Try broadening the search." : "No trials available."}
              </div>
            ) : (
              <>
                <div className="section-header">
                  <div className="section-icon">📊</div>
                  {step === "results" ? (
                    <>
                      <h2>Trial Results</h2>
                      <span className="result-count">
                        {results.total?.toLocaleString()} total{results.returned < results.total ? ` · ${results.returned} loaded` : ""}
                        {chartFilters.length > 0 ? ` · ${filteredTrials.length} matching` : ""}
                      </span>
                    </>
                  ) : (
                    <>
                      <h2>Browse Trials</h2>
                      <span className="result-count">
                        {(results || baseResults).total?.toLocaleString()} total{(results || baseResults).returned < (results || baseResults).total ? ` · ${(results || baseResults).returned} loaded` : ""}{chartFilters.length > 0 ? ` · ${filteredTrials.length} matching` : ""}
                      </span>
                    </>
                  )}
                </div>
              <div className="results-layout">
                {/* Charts */}
                <TrialsCharts
                  trials={(results || baseResults).results}
                  aggData={aggData}
                  activeFilters={chartFilters}
                  onFilter={handleChartFilter}
                />

                {/* Results list — paginated */}
                <div className={`results-list ${selectedTrial ? "with-detail" : ""}`}>
                  {filteredTrials.slice(0, displayCount).map((trial) => (
                    <div
                      key={trial.nct_id}
                      className={`trial-card ${selectedTrial?.nct_id === trial.nct_id ? "selected" : ""}`}
                      onClick={() => setSelectedTrial(trial.nct_id === selectedTrial?.nct_id ? null : trial)}
                    >
                      <div className="trial-card-top">
                        <div className="trial-badges">
                          <span className={`status-badge ${STATUS_CLASS[trial.status] || "status-other"}`}>
                            {STATUS_LABEL[trial.status] || trial.status}
                          </span>
                          {trial.phase && trial.phase !== "N/A" && (
                            <span className={`phase-badge ${PHASE_CLASS[trial.phase] || "phase-na"}`}>
                              {trial.phase}
                            </span>
                          )}
                        </div>
                        <span className="nct-id">{trial.nct_id}</span>
                      </div>
                      <div className="trial-title">{trial.title}</div>
                      <div className="trial-meta-row">
                        {trial.sponsor && (
                          <span className="trial-meta-item">
                            <span className="meta-label">Sponsor</span> {trial.sponsor}
                          </span>
                        )}
                        {trial.enrollment && (
                          <span className="trial-meta-item">
                            <span className="meta-label">N</span> {trial.enrollment.toLocaleString()}
                          </span>
                        )}
                        {trial.arm_count > 0 && (
                          <span className="trial-meta-item">
                            <span className="meta-label">Arms</span> {trial.arm_count}
                          </span>
                        )}
                      </div>
                      {trial.conditions && (
                        <div className="trial-conditions">{trial.conditions}</div>
                      )}
                    </div>
                  ))}
                  {filteredTrials.length > displayCount && (
                    <button
                      className="load-more-btn"
                      onClick={() => setDisplayCount((n) => n + 25)}
                    >
                      Load {Math.min(25, filteredTrials.length - displayCount)} more
                      <span className="load-more-sub"> ({displayCount}/{filteredTrials.length} shown)</span>
                    </button>
                  )}
                </div>

                {/* Detail panel */}
                {selectedTrial && (
                  <div className="trial-detail slide-in">
                    <div className="detail-header">
                      <h3>Trial Detail</h3>
                      <button className="close-btn" onClick={() => setSelectedTrial(null)}>
                        ×
                      </button>
                    </div>

                    <div className="detail-nct">
                      <a
                        href={`https://clinicaltrials.gov/study/${selectedTrial.nct_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="nct-link"
                      >
                        {selectedTrial.nct_id} ↗
                      </a>
                    </div>

                    <h4 className="detail-title">{selectedTrial.title}</h4>

                    <div className="detail-grid">
                      <div className="detail-row">
                        <span className="detail-label">Status</span>
                        <span className={`status-badge ${STATUS_CLASS[selectedTrial.status] || "status-other"}`}>
                          {STATUS_LABEL[selectedTrial.status] || selectedTrial.status}
                        </span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-label">Phase</span>
                        <span>{selectedTrial.phase || "—"}</span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-label">Study Type</span>
                        <span>{selectedTrial.study_type || "—"}</span>
                      </div>
                      {selectedTrial.enrollment && (
                        <div className="detail-row">
                          <span className="detail-label">Enrollment</span>
                          <span>
                            {selectedTrial.enrollment.toLocaleString()}
                            {selectedTrial.enrollment_type ? ` (${selectedTrial.enrollment_type})` : ""}
                          </span>
                        </div>
                      )}
                      {selectedTrial.arm_count > 0 && (
                        <div className="detail-row">
                          <span className="detail-label">Arms</span>
                          <span>{selectedTrial.arm_count}</span>
                        </div>
                      )}
                      {selectedTrial.sponsor && (
                        <div className="detail-row">
                          <span className="detail-label">Sponsor</span>
                          <span>{selectedTrial.sponsor}</span>
                        </div>
                      )}
                      {selectedTrial.start_date && (
                        <div className="detail-row">
                          <span className="detail-label">Start</span>
                          <span>{String(selectedTrial.start_date).split("T")[0]}</span>
                        </div>
                      )}
                      {selectedTrial.completion_date && (
                        <div className="detail-row">
                          <span className="detail-label">Completion</span>
                          <span>{String(selectedTrial.completion_date).split("T")[0]}</span>
                        </div>
                      )}
                      {selectedTrial.has_dmc !== null && (
                        <div className="detail-row">
                          <span className="detail-label">DMC</span>
                          <span>{selectedTrial.has_dmc ? "Yes" : "No"}</span>
                        </div>
                      )}
                    </div>

                    {selectedTrial.conditions && (
                      <div className="detail-section">
                        <div className="detail-section-label">Conditions</div>
                        <div className="detail-section-value">{selectedTrial.conditions}</div>
                      </div>
                    )}

                    {selectedTrial.interventions && (
                      <div className="detail-section">
                        <div className="detail-section-label">Interventions</div>
                        <div className="detail-section-value">{selectedTrial.interventions}</div>
                      </div>
                    )}

                    {selectedTrial.primary_outcome && (
                      <div className="detail-section">
                        <div className="detail-section-label">Primary Outcome</div>
                        <div className="detail-section-value primary-outcome">
                          {selectedTrial.primary_outcome}
                        </div>
                      </div>
                    )}

                    {selectedTrial.why_stopped && (
                      <div className="detail-section">
                        <div className="detail-section-label">Why Stopped</div>
                        <div className="detail-section-value why-stopped">
                          {selectedTrial.why_stopped}
                        </div>
                      </div>
                    )}

                    {/* KG lineage callout */}
                    <div className="kg-lineage-box">
                      <div className="kg-lineage-title">🔗 KG Semantic Bridge</div>
                      <p className="kg-lineage-desc">
                        This trial's <strong>primary outcome</strong> concept maps to SDTM{" "}
                        <code>AE.AETERM</code> / <code>SUPPAE</code> via the CDISC Knowledge
                        Graph — enabling cross-source lineage from ClinicalTrials.gov protocol
                        design all the way to patient-level SDTM data.
                      </p>
                      <div className="kg-lineage-path">
                        ClinicalTrials.gov Protocol → KG Semantic Layer → SDTM Domain → Subject-Level Data
                      </div>
                    </div>
                  </div>
                )}
              </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
