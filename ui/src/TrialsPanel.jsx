import { useState, useCallback, useMemo, useEffect, useRef, Fragment } from "react";
import { resolveTrialQuery, executeTrialQuery, executeTrialAgg, executeSponsorSearch, executeConditionSearch, executeInterventionSearch, FILTER_CATALOG } from "./trialsEngine";
import TrialsCharts, { computeStats } from "./TrialsCharts";
import RulesManager from "./RulesManager";
import InsightPanel from "./InsightPanel";
import OperationalKPIs from "./OperationalKPIs";
import StrategicKGQuestions from "./StrategicKGQuestions";
import TrialsMap from "./TrialsMap";
import AskBar from "./AskBar";
import "./OperationalKPIs.css";
import "./StrategicKGQuestions.css";
import { useDataQuality } from "./useDataQuality";
import "./TrialsPanel.css";
import "./GraphIntelligence.css";

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

// ── Trials Like This — graph-neighbor similar trials ────────────────────────
function TrialsLikeThis({ nctId }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = async () => {
    if (loading || data) return;
    setLoading(true); setError(null);
    try {
      const base = import.meta.env.VITE_TRIALS_API_BASE || "";
      const url = base
        ? `${base}/api/graph/trials-like?nct_id=${encodeURIComponent(nctId)}&limit=8`
        : `/api/graph?path=trials-like&nct_id=${encodeURIComponent(nctId)}&limit=8`;
      const r = await fetch(url);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed");
      setData(d);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    setOpen(!open);
    if (!open && !data && !loading) load();
  };

  return (
    <div className="trials-like-section">
      <button className="trials-like-toggle" onClick={toggle}>
        <span className="tl-kg-badge">KG</span>
        {open ? "▾" : "▸"} Similar Trials via Knowledge Graph
        {data ? <span className="tl-count"> ({data.length})</span> : null}
      </button>

      {open && (
        <div className="trials-like-body">
          {loading && <div className="tl-loading"><div className="loading-spinner" style={{ width: 16, height: 16 }} /> <span>Querying graph…</span></div>}
          {error && <div className="tl-error">⚠ {error}</div>}
          {data && data.length === 0 && <div className="tl-empty">No similar trials found in the knowledge graph.</div>}
          {data && data.map((t, i) => (
            <div key={t.nct_id} className="tl-row">
              <div className="tl-row-top">
                <a href={`https://clinicaltrials.gov/study/${t.nct_id}`} target="_blank" rel="noreferrer" className="tl-nct-link">
                  {t.nct_id} ↗
                </a>
                <span className="tl-match-score">
                  {t.shared_conditions}c + {t.shared_interventions}i match
                </span>
              </div>
              <div className="tl-title">{t.title?.length > 80 ? t.title.slice(0, 78) + "…" : t.title}</div>
              <div className="tl-meta">
                {t.phase && <span className="tl-tag">{t.phase}</span>}
                {t.status && <span className="tl-tag">{t.status.replace(/_/g, " ")}</span>}
                {t.enrollment && <span className="tl-tag">{t.enrollment.toLocaleString()} enrolled</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TrialsPanel() {
  const [query, setQuery] = useState("");
  const [step, setStep] = useState("question"); // question | loading | results | error
  const [resolutions, setResolutions] = useState([]);
  const [results, setResults] = useState(null);
  const [selectedTrial, setSelectedTrial] = useState(null);
  const [error, setError] = useState(null);
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
  const [rulesOpen, setRulesOpen] = useState(false);
  const [insightTarget, setInsightTarget] = useState(null); // { type, name } for InsightPanel
  const [okpiView, setOkpiView] = useState(null); // controlled by AskBar → OperationalKPIs
  const [subView, setSubView] = useState("overview"); // sub-tab: overview | condition | sponsor | browse
  const okpiRef = useRef(null);

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
    setStep("question");
    setQuery("");
    setResolutions([]);
    setActiveResolutions([]);
    setDisplayCount(25);
    // Re-fetch base agg when resetting
    executeTrialAgg({}).then(setAggData).catch(() => {});
  }, []);

  // Build filter params for operational KPI endpoints (mirrors buildCurrentParams but as plain object)
  const okpiFilterParams = useMemo(() => {
    const p = {};
    for (const r of activeResolutions) {
      if (r.value && r.param !== "q" && r.param !== "graph") {
        p[r.param] = p[r.param] ? `${p[r.param]},${r.value}` : r.value;
      }
    }
    for (const f of chartFilters) {
      if (f.field === "phase" || f.field === "status" || f.field === "sponsor" || f.field === "condition" || f.field === "intervention" || f.field === "country") {
        p[f.field] = p[f.field] ? `${p[f.field]},${f.value}` : f.value;
      }
    }
    return p;
  }, [activeResolutions, chartFilters]);

  // Geo filter params — subset safe for the geographic-intelligence endpoint
  // (intervention + status cause heavy multi-table JOINs → timeouts)
  const geoFilterParams = useMemo(() => {
    const { condition, phase, sponsor, country } = okpiFilterParams;
    return { condition, phase, sponsor, country };
  }, [okpiFilterParams]);

  // Handle entity insight — clicking a chart bar label opens the InsightPanel
  const handleEntityInsight = useCallback((type, name) => {
    setInsightTarget({ type, name });
  }, []);

  // AskBar callbacks: apply extracted filters and navigate to OKPI tab
  const handleAskFilters = useCallback((filters) => {
    const newFilters = [];
    for (const [field, value] of Object.entries(filters)) {
      if (value) newFilters.push({ field, value });
    }
    if (newFilters.length) setChartFilters(newFilters);
    setStep("results");
  }, []);

  const handleAskOkpi = useCallback((view) => setOkpiView(view), []);
  const handleAskScrollOkpi = useCallback(() => {
    setTimeout(() => okpiRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 200);
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

      {/* ── Unified Smart Intake ───────────────────────────────── */}
      <AskBar
        onFiltersExtracted={handleAskFilters}
        onOkpiView={handleAskOkpi}
        onScrollToOkpi={handleAskScrollOkpi}
      />

      {/* ── Sub-tab navigation ─────────────────────────────────── */}
      <div className="sub-tab-bar">
        {[
          { key: "overview",  label: "Overview",          icon: "📊" },
          { key: "condition", label: "Assess Condition",  icon: "🧬" },
          { key: "sponsor",   label: "Assess Sponsor",    icon: "🏢" },
          { key: "browse",    label: "Browse Trials",     icon: "📋" },
        ].map(t => (
          <button
            key={t.key}
            className={`sub-tab${subView === t.key ? " sub-tab-active" : ""}`}
            onClick={() => setSubView(t.key)}
          >
            <span className="sub-tab-icon">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      <div className="trials-body">

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
              <div className="error-icon">&#x26A0;&#xFE0F;</div>
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
                {/* ── Overview sub-tab ──────────────────────────────── */}
                {subView === "overview" && (<>
                <StrategicKGQuestions showOnly={["kq3","kq4"]} hideHeader />

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
                  onEntityInsight={handleEntityInsight}
                  fetchSponsors={fetchSponsors}
                  fetchConditions={fetchConditions}
                  fetchInterventions={fetchInterventions}
                  normalizeAggData={normalizeAggData}
                />

                {/* ── Geographic Map ───────────────────────────────── */}
                <TrialsMap
                  filterParams={geoFilterParams}
                  onCountryFilter={(country) => {
                    setChartFilters(prev => {
                      const without = prev.filter(f => f.field !== "country");
                      return [...without, { field: "country", value: country }];
                    });
                  }}
                  onCountryClear={() => {
                    setChartFilters(prev => prev.filter(f => f.field !== "country"));
                  }}
                />
                </>)}

                {/* ── Assess Condition sub-tab ──────────────────────── */}
                {subView === "condition" && (<>
                <StrategicKGQuestions showOnly={["eq2","path"]} hideHeader />
                <div ref={okpiRef}>
                  <OperationalKPIs filterParams={okpiFilterParams} initialView={okpiView} showViews={["failure","enrollment","geography"]} />
                </div>
                </>)}

                {/* ── Assess Sponsor sub-tab ────────────────────────── */}
                {subView === "sponsor" && (<>
                <StrategicKGQuestions showOnly={["eq1","eq3"]} hideHeader />
                <div ref={okpiRef}>
                  <OperationalKPIs filterParams={okpiFilterParams} initialView={okpiView} showViews={["sponsors"]} />
                </div>
                </>)}

                {/* ── Browse Trials sub-tab ─────────────────────────── */}
                {subView === "browse" && (<>
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

                    {/* Trials Like This — graph-based similarity */}
                    <TrialsLikeThis nctId={selectedTrial.nct_id} />
                  </div>
                )}
                </div>{/* closes results-and-detail */}
                </>)}
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

    <InsightPanel insightTarget={insightTarget} onClose={() => setInsightTarget(null)} />

    </>
  );
}
