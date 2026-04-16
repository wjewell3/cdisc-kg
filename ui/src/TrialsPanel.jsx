import { useState, useCallback, useMemo, useEffect, Fragment } from "react";
import { resolveTrialQuery, executeTrialQuery, executeTrialAgg, executeSponsorSearch, executeConditionSearch, executeInterventionSearch, TRIAL_QUERIES, FILTER_CATALOG } from "./trialsEngine";
import TrialsCharts, { computeStats } from "./TrialsCharts";
import RulesManager from "./RulesManager";
import { useDataQuality } from "./useDataQuality";
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

export default function TrialsPanel({ focusNctId }) {
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
  const [chartResults, setChartResults] = useState(null); // rows re-fetched on chart filter clicks
  const [chartAggData, setChartAggData] = useState(null); // aggregates re-fetched on chart filter clicks
  const [displayCount, setDisplayCount] = useState(25);
  const [intelligence, setIntelligence] = useState(null); // { data, loading, error }
  const [intelStep, setIntelStep] = useState(0);
  const [searchFocused, setSearchFocused] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);

  const currentAgg = chartAggData || aggData;
  const panelStats = useMemo(() => computeStats(currentAgg), [currentAgg]);
  const panelBaseStats = useMemo(() => computeStats(aggData), [aggData]);

  const {
    rules, addGrouping, removeGrouping, updateGrouping, setEnrollmentBounds,
    exportRules, importRules, normalizeAggData, enrollMin, enrollMax,
  } = useDataQuality();

  const INTEL_STEPS = [
    "Fetching trial record from AACT snapshot…",
    "Searching for completed trials with similar conditions…",
    "Computing termination rate, duration & enrollment benchmarks…",
    "Asking GPT-4.1 to write the risk briefing…",
    "Almost there — waiting on the AI…",
  ];

  useEffect(() => {
    if (!intelligence?.loading) { setIntelStep(0); return; }
    const timings = [800, 2500, 4500, 7000];
    const timers = timings.map((delay, i) =>
      setTimeout(() => setIntelStep(i + 1), delay)
    );
    return () => timers.forEach(clearTimeout);
  }, [intelligence?.loading]);

  const analyzeTrialIntelligence = useCallback(async (nct_id) => {
    setIntelStep(0);
    setIntelligence({ loading: true, data: null, error: null });
    try {
      const base = import.meta.env.VITE_TRIALS_API_BASE || "";
      const endpoint = base ? `${base}/api/trial-intelligence` : `/api/intelligence`;
      const url = new URL(endpoint, window.location.origin);
      url.searchParams.set("nct_id", nct_id);
      if (enrollMin !== null) url.searchParams.set("min_enrollment", String(enrollMin));
      if (enrollMax !== null) url.searchParams.set("max_enrollment", String(enrollMax));
      const r = await fetch(url.toString());
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setIntelligence({ loading: false, data, error: null });
    } catch (e) {
      setIntelligence({ loading: false, data: null, error: e.message });
    }
  }, [enrollMin, enrollMax]);

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

  // When navigated here with a specific NCT ID (e.g. from SiteIntelligence),
  // search for that trial and open its intelligence panel.
  useEffect(() => {
    if (!focusNctId) return;
    const base = import.meta.env.VITE_TRIALS_API_BASE || "";
    const url = `${base}/api/trials?q=${encodeURIComponent(focusNctId)}&limit=1`;
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (data.results?.[0]) {
          setStep("results");
          setResults(data);
          setSelectedTrial(data.results[0]);
          setIntelligence(null);
        }
      })
      .catch(() => {});
  }, [focusNctId]);

  // When chart filters change, re-query the server for filtered rows + stats.
  // All filter types (phase/status/sponsor/enrollment-range) go to the server.
  const ENROLL_BUCKETS_SERVER = {
    "< 100": [0, 99], "100\u2013499": [100, 499], "500\u2013999": [500, 999],
    "1k\u20134.9k": [1000, 4999], "5k\u201319k": [5000, 19999], "\u2265 20k": [20000, Infinity],
  };

  // Build the current effective filter params (text search + chart filters).
  const buildCurrentParams = useCallback(() => {
    const params = {};
    for (const r of activeResolutions) {
      if (r.value) params[r.param] = params[r.param] ? `${params[r.param]},${r.value}` : r.value;
    }
    for (const f of chartFilters) {
      if (f.field === "phase" || f.field === "status" || f.field === "sponsor" || f.field === "condition" || f.field === "intervention") {
        params[f.field] = params[f.field] ? `${params[f.field]},${f.value}` : f.value;
      } else if (f.field === "_enroll_range") {
        const [min, max] = ENROLL_BUCKETS_SERVER[f.value] || [];
        if (min !== undefined) {
          const curMin = params.min_enrollment !== undefined ? parseInt(params.min_enrollment) : Infinity;
          const curMax = params.max_enrollment !== undefined ? parseInt(params.max_enrollment) : -1;
          params.min_enrollment = String(Math.min(curMin === Infinity ? min : curMin, min));
          if (isFinite(max)) params.max_enrollment = String(Math.max(curMax, max));
        }
      }
    }
    // Apply DQ enrollment bounds (override chart-derived bounds with the stricter value)
    if (enrollMin !== null) {
      params.min_enrollment = params.min_enrollment
        ? String(Math.max(parseInt(params.min_enrollment), enrollMin))
        : String(enrollMin);
    }
    if (enrollMax !== null) {
      params.max_enrollment = params.max_enrollment
        ? String(Math.min(parseInt(params.max_enrollment), enrollMax))
        : String(enrollMax);
    }
    return params;
  }, [activeResolutions, chartFilters, enrollMin, enrollMax]);

  const fetchSponsors = useCallback((q) => executeSponsorSearch(buildCurrentParams(), q), [buildCurrentParams]);
  const fetchConditions = useCallback((q) => executeConditionSearch(buildCurrentParams(), q), [buildCurrentParams]);
  const fetchInterventions = useCallback((q) => executeInterventionSearch(buildCurrentParams(), q), [buildCurrentParams]);

  useEffect(() => {
    if (chartFilters.length === 0) {
      setChartResults(null);
      setChartAggData(null);
      return;
    }
    const params = buildCurrentParams();
    const tid = setTimeout(async () => {
      try {
        const [data, agg] = await Promise.all([
          executeTrialQuery(params, 500),
          executeTrialAgg(params),
        ]);
        setChartResults(data);
        setChartAggData(agg);
        setDisplayCount(25);
      } catch {}
    }, 150);
    return () => clearTimeout(tid);
  }, [chartFilters, activeResolutions, buildCurrentParams]);

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
    setShowFilterPicker(false);
    setDisplayCount(25);

    const { params, resolutions: resolved } = resolveTrialQuery(text);
    setResolutions(resolved);

    const isFreetextOnly = resolved.length === 1 && resolved[0].param === 'q';

    if (isFreetextOnly) {
      // Free-text: need a full server search
      setStep("loading");
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
    } else {
      // Structured filters: add as chart filters (highlights bars, same as clicking)
      setActiveResolutions([]);
      setResults(null);
      setChartFilters(resolved.map(r => ({ field: r.param, value: r.value })));
      setStep("results");
    }
  }, []);

  const handlePreset = useCallback((q) => { setSearchFocused(false); runQuery(q.text); }, [runQuery]);

  const handleSubmit = useCallback(
    (e) => {
      e.preventDefault();
      if (query.trim()) runQuery(query);
    },
    [query, runQuery]
  );

  const filteredTrials = useMemo(() => {
    // chartResults takes priority — real server-filtered rows when chart filters are active
    const source = chartResults || results || baseResults;
    if (!source?.results) return [];
    return source.results;
  }, [chartResults, results, baseResults]);

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
    setChartResults(null);
    setChartAggData(null);
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
    <>
    <div className="trials-panel">
      {/* Header bar */}
      <div className="trials-header">
        <div className="trials-header-left">
          <div className="trials-logo">🌐</div>
          <div>
            <h1 className="trials-title">Cross-Trial Intelligence</h1>
            <p className="trials-subtitle">580k+ ClinicalTrials.gov studies — search, filter, explore</p>
          </div>
        </div>
        <div className="trials-badge-row">
          <button className="rules-manager-btn" onClick={() => setRulesOpen(true)}>
            ⚙ Rules{(rules.groupings.length + (enrollMin !== null || enrollMax !== null ? 1 : 0)) > 0 ? ` (${rules.groupings.length + (enrollMin !== null || enrollMax !== null ? 1 : 0)})` : ""}
            {(enrollMin !== null || enrollMax !== null) && <span className="rules-bounds-badge">●</span>}
          </button>
          <span className="aact-badge">AACT Snapshot</span>
          <span className="sdtm-badge">580k studies</span>
        </div>
      </div>

      <div className="trials-body">

        {/* ── Section 1: Search + preset queries ───────────────────────── */}
        <div className="trials-section compact-section">
          <div className="section-header">
            <div className="section-icon">💬</div>
            <h2>Search Trials</h2>
            {step !== "question" && (
              <button className="reset-btn" onClick={reset}>Clear</button>
            )}
          </div>

          <div className="search-wrap">
            <form onSubmit={handleSubmit} className="query-form" style={{ margin: 0 }}>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
                placeholder='e.g., "Phase 3 Alzheimer trials" or "Recruiting breast cancer immunotherapy"'
                className="query-input"
              />
              <button type="submit" className="query-submit" disabled={!query.trim()}>
                Search →
              </button>
            </form>

            {/* Preset queries — shown as dropdown when search box is focused */}
            {searchFocused && (
              <div className="preset-dropdown">
                {TRIAL_QUERIES.map((q) => (
                  <button
                    key={q.id}
                    className={`preset-dropdown-item ${activeQuery === q.text ? "preset-card-active" : ""}`}
                    onMouseDown={(e) => { e.preventDefault(); handlePreset(q); }}
                  >
                    <span className="preset-text">"{q.text}"</span>
                    <span className="preset-desc">{q.description}</span>
                    <div className="preset-tags">
                      {q.tags.map((t) => <span key={t} className="preset-tag">{t}</span>)}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Active filter pills */}
        {(chartFilters.length > 0 || activeResolutions.length > 0) && (
          <div className="kg-params-bar">
            <span className="kg-params-label">Filters →</span>
            {activeResolutions.map((r, i) => (
              <span key={i} className="kg-param-pill kg-param-removable">
                <code>{r.param}</code>
                {r.value && <><span className="kg-eq">=</span><span className="kg-val">{r.value}</span></>}
                <button className="kg-param-remove" onClick={() => removeResolution(i)} aria-label={`Remove ${r.param}`}>×</button>
              </span>
            ))}
            {chartFilters.map((cf, i) => (
              <span key={i} className="kg-param-pill kg-filter-pill">
                <span className="kg-filter-icon">🔍</span>
                <span>{cf.field.replace(/^_/, "").replace(/_LABEL$/, "")}</span>
                <span className="kg-eq">=</span>
                <span className="kg-val">{cf.value}</span>
                <button className="kg-filter-clear" onClick={() => setChartFilters((prev) => prev.filter((_, j) => j !== i))} aria-label="Clear filter">×</button>
              </span>
            ))}
            <button className="kg-filter-clear" style={{marginLeft:"auto"}} onClick={() => { setChartFilters([]); reset(); }}>Clear all ×</button>
          </div>
        )}

        {/* ── Section 2: Visual Insights (charts as filters) ───────────── */}
        {step === "loading" ? (
          <div className="trials-section slide-in">
            <div className="loading-state">
              <div className="loading-spinner" />
              <p>Querying…</p>
            </div>
          </div>
        ) : step === "error" ? (
          <div className="trials-section slide-in">
            <div className="error-state">
              <div className="error-icon">⚠️</div>
              <p className="error-msg">{error?.includes("ECONNREFUSED") || error?.includes("connect")
                ? "AACT database is temporarily unavailable. Please try again soon."
                : `Query failed: ${error}`}</p>
              <button className="reset-btn" onClick={reset}>Try Again</button>
            </div>
          </div>
        ) : (
          <div className="trials-section slide-in">
            {baseLoading && !results ? (
              <div className="loading-state">
                <div className="loading-spinner" />
                <p>Loading trial data…</p>
              </div>
            ) : !(results || baseResults) ? (
              <div className="no-results">Trial data unavailable — AACT database may be offline.</div>
            ) : (results || baseResults).total === 0 ? (
              <div className="no-results">No trials found. Try broadening the search.</div>
            ) : (
              <>
                <div className="section-header">
                  <div className="section-icon">📊</div>
                  <h2>Visual Insights</h2>
                  <span className="result-count">
                    {(chartResults || results || baseResults).total?.toLocaleString()} trials
                    {chartFilters.length > 0 ? ` · ${filteredTrials.length} shown` : ""}
                  </span>
                </div>
              <div className="results-layout">
                {/* Charts — full width above results */}
                <TrialsCharts
                  trials={(results || baseResults).results}
                  aggData={currentAgg}
                  baseAggData={aggData}
                  stats={panelStats}
                  baselineStats={panelBaseStats}
                  hasFilteredStats={chartFilters.length > 0}
                  activeFilters={chartFilters}
                  onFilter={handleChartFilter}
                  fetchSponsors={fetchSponsors}
                  fetchConditions={fetchConditions}
                  fetchInterventions={fetchInterventions}
                  normalizeAggData={normalizeAggData}
                />

                {/* ── Results list + detail panel row ──────────────────── */}
                <div className="results-and-detail">
                <div className="results-list">
                  {filteredTrials.slice(0, displayCount).map((trial) => (
                    <div
                      key={trial.nct_id}
                      className={`trial-card ${selectedTrial?.nct_id === trial.nct_id ? "selected" : ""}`}
                      onClick={() => { setSelectedTrial(trial.nct_id === selectedTrial?.nct_id ? null : trial); setIntelligence(null); }}
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
                  <div className="trial-detail slide-in" style={{maxHeight: '75vh', overflowY: 'auto'}}>
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

                    {/* Trial Intelligence */}
                    {!intelligence && (
                      <button
                        className="intelligence-analyze-btn"
                        onClick={() => analyzeTrialIntelligence(selectedTrial.nct_id)}
                      >
                        🔍 Analyze Trial Risk
                      </button>
                    )}
                    {intelligence?.loading && (
                      <div className="intelligence-loading">
                        <span className="intelligence-spinner" />
                        <span className="intel-step-msg">{INTEL_STEPS[intelStep]}</span>
                      </div>
                    )}
                    {intelligence?.error && (
                      <div className="intelligence-error">
                        ⚠ Intelligence unavailable: {intelligence.error}
                      </div>
                    )}
                    {intelligence?.data && (() => {
                      const { risk_signals: rs, briefing, comparable_examples } = intelligence.data;
                      return (
                        <div className="intelligence-panel">
                          <div className="intelligence-header">
                            <span className="intelligence-icon">🧠</span>
                            <h4>Trial Intelligence Briefing</h4>
                            <button className="intelligence-close" onClick={() => setIntelligence(null)}>×</button>
                          </div>

                          <div className="intelligence-metrics">
                            <div className={`intel-metric ${rs.high_termination_risk ? "intel-risk" : "intel-ok"}`}>
                              <span className="intel-metric-val">
                                {rs.termination_rate_pct !== null ? `${rs.termination_rate_pct}%` : "—"}
                              </span>
                              <span className="intel-metric-label">Early Termination Rate</span>
                              <span className="intel-metric-sub">vs ~15% industry avg</span>
                            </div>
                            <div className="intel-metric">
                              <span className="intel-metric-val">
                                {rs.median_duration_days ? `${Math.round(rs.median_duration_days / 30.4)} mo` : "—"}
                              </span>
                              <span className="intel-metric-label">Median Duration</span>
                              <span className="intel-metric-sub">
                                {rs.duration_p25_days && rs.duration_p75_days
                                  ? `P25–P75: ${Math.round(rs.duration_p25_days / 30.4)}–${Math.round(rs.duration_p75_days / 30.4)} mo`
                                  : "comparable trials"}
                              </span>
                            </div>
                            <div className={`intel-metric ${rs.enrollment_vs_median !== null && Math.abs(rs.enrollment_vs_median) > 50 ? "intel-warn" : "intel-ok"}`}>
                              <span className="intel-metric-val">
                                {rs.median_comparable_enrollment
                                  ? rs.median_comparable_enrollment.toLocaleString()
                                  : "—"}
                              </span>
                              <span className="intel-metric-label">Median Comparable Enroll</span>
                              <span className="intel-metric-sub">
                                {rs.enrollment_vs_median !== null
                                  ? `This trial: ${rs.enrollment_vs_median > 0 ? "+" : ""}${rs.enrollment_vs_median}% vs median`
                                  : `${rs.comparable_count} comparable trials`}
                              </span>
                            </div>
                          </div>

                          {rs.common_stop_reasons?.length > 0 && (
                            <div className="intel-stop-reasons">
                              <span className="intel-label">Common early stop reasons:</span>
                              {rs.common_stop_reasons.map((r, i) => (
                                <span key={i} className="intel-stop-tag">{r}</span>
                              ))}
                            </div>
                          )}

                          {briefing ? (
                            <div className="intelligence-briefing">
                              {briefing.split("\n\n").map((para, i) => (
                                <p key={i}>{para}</p>
                              ))}
                            </div>
                          ) : (
                            <div className="intelligence-no-llm">
                              <em>AI narrative unavailable — add GITHUB_COPILOT_TOKEN to the aact-credentials k8s secret to enable plain-English briefing.</em>
                            </div>
                          )}

                          {comparable_examples?.length > 0 && (
                            <details className="intel-comparables">
                              <summary>View {rs.comparable_count} comparable trials sampled</summary>
                              <table className="intel-comparables-table">
                                <thead>
                                  <tr><th>NCT ID</th><th>Status</th><th>Duration</th><th>Enrollment</th><th>Stop Reason</th></tr>
                                </thead>
                                <tbody>
                                  {comparable_examples.map((c) => (
                                    <tr key={c.nct_id}>
                                      <td>
                                        <a href={`https://clinicaltrials.gov/study/${c.nct_id}`} target="_blank" rel="noreferrer">
                                          {c.nct_id}
                                        </a>
                                      </td>
                                      <td>{c.status}</td>
                                      <td>{c.duration_months != null ? `${c.duration_months} mo` : "—"}</td>
                                      <td>{c.enrollment ? c.enrollment.toLocaleString() : "—"}</td>
                                      <td>{c.why_stopped || "—"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </details>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}
                </div>{/* closes results-and-detail */}
              </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>

    {rulesOpen && (
      <RulesManager
        rules={rules}
        addGrouping={addGrouping}
        removeGrouping={removeGrouping}
        updateGrouping={updateGrouping}
        setEnrollmentBounds={setEnrollmentBounds}
        enrollMin={enrollMin}
        enrollMax={enrollMax}
        exportRules={exportRules}
        importRules={importRules}
        onClose={() => setRulesOpen(false)}
      />
    )}

    </>
  );
}
