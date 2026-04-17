/**
 * OperationalKPIs.jsx — Cohort-level operational intelligence panels.
 *
 * Three views, each answering a strategic question:
 * 1. Failure Analysis — termination rates + why trials fail
 * 2. Sponsor Performance — completion rate leaderboard
 * 3. Enrollment Benchmark — anticipated vs actual enrollment by design type
 *
 * All views react to the current chart filters (condition, phase, sponsor, etc.)
 */
import { useState, useEffect, useCallback, useMemo } from "react";

const PALETTE = ["#58a6ff", "#3fb950", "#d29922", "#f85149", "#a371f7", "#39d2c0", "#f778ba", "#8b949e"];

function trialsApiBase() {
  return import.meta.env.VITE_TRIALS_API_BASE || "";
}

function rateColor(rate) {
  if (rate == null) return "#8b949e";
  return rate >= 75 ? "#3fb950" : rate >= 50 ? "#d29922" : "#f85149";
}

// ── Mini bar component (reused) ────────────────────────────────────
function MiniBar({ data, title, maxItems = 10, valueLabel = "", highlightFn }) {
  const items = data.slice(0, maxItems);
  if (!items.length) return null;
  const maxVal = Math.max(...items.map(d => d.value), 1);
  return (
    <div className="okpi-chart">
      <div className="okpi-chart-title">{title}</div>
      {items.map((d, i) => (
        <div key={d.label} className="okpi-bar-row">
          <span className="okpi-bar-label" title={d.label}>
            {d.label.length > 28 ? d.label.slice(0, 26) + "…" : d.label}
          </span>
          <div className="okpi-bar-track">
            <div
              className="okpi-bar-fill"
              style={{
                width: `${Math.max((d.value / maxVal) * 100, 3)}%`,
                background: highlightFn ? highlightFn(d) : PALETTE[i % PALETTE.length],
              }}
            />
          </div>
          <span className="okpi-bar-count">
            {typeof d.value === "number" && d.value % 1 !== 0 ? d.value.toFixed(1) : d.value}
            {valueLabel}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Failure Analysis View ──────────────────────────────────────────
function FailureAnalysis({ filterParams }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const base = trialsApiBase();
    const url = new URL(base ? `${base}/api/failure-analysis` : `/api/analytics`, window.location.origin);
    if (!base) url.searchParams.set("mode", "failure-analysis");
    for (const [k, v] of Object.entries(filterParams)) {
      if (v) url.searchParams.set(k, v);
    }
    fetch(url.toString())
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) throw new Error(d.error || "Failed");
        setData(d);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [filterParams]);

  if (loading) return <div className="okpi-loading">Analyzing failure patterns…</div>;
  if (error) return <div className="okpi-error">⚠ {error}</div>;
  if (!data) return null;

  const { counts, termination_rate_pct, stop_reasons, by_condition, by_phase } = data;

  return (
    <div className="okpi-view">
      {/* KPI cards */}
      <div className="okpi-kpis">
        <div className="okpi-kpi">
          <div className="okpi-kpi-value">{counts.total.toLocaleString()}</div>
          <div className="okpi-kpi-label">Total Trials</div>
        </div>
        <div className="okpi-kpi">
          <div className="okpi-kpi-value" style={{ color: termination_rate_pct != null ? rateColor(100 - termination_rate_pct) : undefined }}>
            {termination_rate_pct != null ? `${termination_rate_pct}%` : "—"}
          </div>
          <div className="okpi-kpi-label">Termination Rate</div>
        </div>
        <div className="okpi-kpi">
          <div className="okpi-kpi-value">{counts.terminated.toLocaleString()}</div>
          <div className="okpi-kpi-label">Terminated</div>
        </div>
        <div className="okpi-kpi">
          <div className="okpi-kpi-value" style={{ color: "#3fb950" }}>{counts.completed.toLocaleString()}</div>
          <div className="okpi-kpi-label">Completed</div>
        </div>
      </div>

      <div className="okpi-charts-grid">
        {/* Why trials fail */}
        {stop_reasons.length > 0 && (
          <MiniBar
            data={stop_reasons.map(r => ({ label: r.reason, value: r.count }))}
            title="Why Trials Fail — Stop Reasons"
            maxItems={12}
          />
        )}

        {/* Termination rate by condition */}
        {by_condition.length > 0 && (
          <MiniBar
            data={by_condition.map(r => ({
              label: `${r.condition} (n=${r.total})`,
              value: r.termination_rate_pct ?? 0,
            }))}
            title="Termination Rate by Condition"
            valueLabel="%"
            highlightFn={(d) => rateColor(100 - d.value)}
          />
        )}

        {/* Termination rate by phase */}
        {by_phase.length > 0 && (
          <MiniBar
            data={by_phase.map(r => ({
              label: `${r.phase} (n=${r.total})`,
              value: r.termination_rate_pct ?? 0,
            }))}
            title="Termination Rate by Phase"
            valueLabel="%"
            highlightFn={(d) => rateColor(100 - d.value)}
          />
        )}
      </div>
    </div>
  );
}

// ── Sponsor Performance View ───────────────────────────────────────
function SponsorPerformance({ filterParams }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sortBy, setSortBy] = useState("completion_rate_pct");

  useEffect(() => {
    setLoading(true);
    setError(null);
    const base = trialsApiBase();
    const url = new URL(base ? `${base}/api/sponsor-performance` : `/api/analytics`, window.location.origin);
    if (!base) url.searchParams.set("mode", "sponsor-performance");
    for (const [k, v] of Object.entries(filterParams)) {
      if (v) url.searchParams.set(k, v);
    }
    fetch(url.toString())
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) throw new Error(d.error || "Failed");
        setData(d);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [filterParams]);

  const sorted = useMemo(() => {
    if (!data?.sponsors) return [];
    return [...data.sponsors].sort((a, b) => (b[sortBy] ?? 0) - (a[sortBy] ?? 0));
  }, [data, sortBy]);

  if (loading) return <div className="okpi-loading">Analyzing sponsor performance…</div>;
  if (error) return <div className="okpi-error">⚠ {error}</div>;
  if (!data) return null;

  return (
    <div className="okpi-view">
      <div className="okpi-table-header">
        <span className="okpi-table-hint">Sponsors with ≥{data.min_trials} trials · sorted by {sortBy === "completion_rate_pct" ? "completion rate" : sortBy === "total" ? "trial count" : sortBy}</span>
        <div className="okpi-sort-btns">
          <button className={sortBy === "completion_rate_pct" ? "okpi-sort-active" : ""} onClick={() => setSortBy("completion_rate_pct")}>By Rate</button>
          <button className={sortBy === "total" ? "okpi-sort-active" : ""} onClick={() => setSortBy("total")}>By Count</button>
        </div>
      </div>
      <div className="okpi-table-wrap">
        <table className="okpi-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Sponsor</th>
              <th>Trials</th>
              <th>Completed</th>
              <th>Terminated</th>
              <th>Completion Rate</th>
              <th>Avg Enrollment</th>
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, 30).map((s, i) => (
              <tr key={s.sponsor}>
                <td className="okpi-rank">{i + 1}</td>
                <td className="okpi-sponsor-name" title={s.sponsor}>
                  {s.sponsor.length > 35 ? s.sponsor.slice(0, 33) + "…" : s.sponsor}
                </td>
                <td>{s.total.toLocaleString()}</td>
                <td style={{ color: "#3fb950" }}>{s.completed.toLocaleString()}</td>
                <td style={{ color: "#f85149" }}>{s.terminated.toLocaleString()}</td>
                <td>
                  <span className="okpi-rate-badge" style={{ background: rateColor(s.completion_rate_pct), color: "#fff" }}>
                    {s.completion_rate_pct != null ? `${s.completion_rate_pct}%` : "—"}
                  </span>
                </td>
                <td>{s.avg_enrollment != null ? s.avg_enrollment.toLocaleString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Enrollment Benchmark View ──────────────────────────────────────
function EnrollmentBenchmark({ filterParams }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [allocation, setAllocation] = useState("");
  const [masking, setMasking] = useState("");

  const fetchData = useCallback((extraParams = {}) => {
    setLoading(true);
    setError(null);
    const base = trialsApiBase();
    const url = new URL(base ? `${base}/api/enrollment-benchmark` : `/api/analytics`, window.location.origin);
    if (!base) url.searchParams.set("mode", "enrollment-benchmark");
    for (const [k, v] of Object.entries({ ...filterParams, ...extraParams })) {
      if (v) url.searchParams.set(k, v);
    }
    fetch(url.toString())
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) throw new Error(d.error || "Failed");
        setData(d);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [filterParams]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleDesignChange = useCallback((field, value) => {
    if (field === "allocation") setAllocation(value);
    if (field === "masking") setMasking(value);
    const params = {};
    if (field === "allocation") params.allocation = value; else if (allocation) params.allocation = allocation;
    if (field === "masking") params.masking = value; else if (masking) params.masking = masking;
    fetchData(params);
  }, [allocation, masking, fetchData]);

  if (loading && !data) return <div className="okpi-loading">Analyzing enrollment patterns…</div>;
  if (error) return <div className="okpi-error">⚠ {error}</div>;
  if (!data) return null;

  const anticipated = data.summary.find(s => s.enrollment_type === "Anticipated");
  const actual = data.summary.find(s => s.enrollment_type === "Actual");
  const ambitionDelta = (anticipated?.avg_enrollment && actual?.avg_enrollment)
    ? Math.round(((anticipated.avg_enrollment - actual.avg_enrollment) / actual.avg_enrollment) * 100)
    : null;

  // Pivot by_allocation for comparison chart
  const allocationMap = {};
  for (const row of data.by_allocation) {
    if (!allocationMap[row.design]) allocationMap[row.design] = {};
    allocationMap[row.design][row.enrollment_type] = row.avg_enrollment;
  }

  return (
    <div className="okpi-view">
      {/* KPI cards */}
      <div className="okpi-kpis">
        <div className="okpi-kpi">
          <div className="okpi-kpi-value">{anticipated?.avg_enrollment?.toLocaleString() ?? "—"}</div>
          <div className="okpi-kpi-label">Avg Anticipated</div>
          <div className="okpi-kpi-sub">{anticipated?.trial_count?.toLocaleString() ?? 0} trials</div>
        </div>
        <div className="okpi-kpi">
          <div className="okpi-kpi-value">{actual?.avg_enrollment?.toLocaleString() ?? "—"}</div>
          <div className="okpi-kpi-label">Avg Actual</div>
          <div className="okpi-kpi-sub">{actual?.trial_count?.toLocaleString() ?? 0} trials</div>
        </div>
        {ambitionDelta != null && (
          <div className="okpi-kpi">
            <div className="okpi-kpi-value" style={{ color: ambitionDelta > 20 ? "#f85149" : ambitionDelta > 0 ? "#d29922" : "#3fb950" }}>
              {ambitionDelta > 0 ? "+" : ""}{ambitionDelta}%
            </div>
            <div className="okpi-kpi-label">Ambition Gap</div>
            <div className="okpi-kpi-sub">{ambitionDelta > 0 ? "anticipated > actual" : "actual ≥ anticipated"}</div>
          </div>
        )}
      </div>

      {/* Design type filters */}
      <div className="okpi-design-filters">
        <label>
          Allocation:
          <select value={allocation} onChange={e => handleDesignChange("allocation", e.target.value)}>
            <option value="">All</option>
            {data.design_options.allocations.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label>
          Masking:
          <select value={masking} onChange={e => handleDesignChange("masking", e.target.value)}>
            <option value="">All</option>
            {data.design_options.maskings.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      </div>

      <div className="okpi-charts-grid">
        {/* Enrollment by allocation type */}
        {Object.keys(allocationMap).length > 0 && (
          <div className="okpi-comparison-chart">
            <div className="okpi-chart-title">Avg Enrollment by Allocation Type</div>
            {Object.entries(allocationMap).map(([design, vals]) => (
              <div key={design} className="okpi-compare-row">
                <span className="okpi-compare-label">{design}</span>
                <div className="okpi-compare-bars">
                  {vals.Anticipated && (
                    <div className="okpi-compare-bar" style={{ background: "#58a6ff" }}>
                      <span>{Math.round(vals.Anticipated).toLocaleString()}</span>
                      <span className="okpi-compare-type">Anticipated</span>
                    </div>
                  )}
                  {vals.Actual && (
                    <div className="okpi-compare-bar" style={{ background: "#3fb950" }}>
                      <span>{Math.round(vals.Actual).toLocaleString()}</span>
                      <span className="okpi-compare-type">Actual</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Operational KPIs Component ────────────────────────────────
const VIEWS = [
  { key: "failure", label: "Failure Analysis", icon: "⚠", question: "What's the real termination rate, and why do trials fail?" },
  { key: "sponsors", label: "Sponsor Performance", icon: "🏆", question: "Which sponsors have the best completion rates?" },
  { key: "enrollment", label: "Enrollment Benchmark", icon: "📊", question: "How does enrollment ambition compare to actuals?" },
];

export default function OperationalKPIs({ filterParams }) {
  const [activeView, setActiveView] = useState("failure");

  return (
    <div className="okpi-container">
      <div className="okpi-tabs">
        {VIEWS.map(v => (
          <button
            key={v.key}
            className={`okpi-tab ${activeView === v.key ? "okpi-tab-active" : ""}`}
            onClick={() => setActiveView(v.key)}
            title={v.question}
          >
            <span className="okpi-tab-icon">{v.icon}</span>
            <span>{v.label}</span>
          </button>
        ))}
      </div>
      <div className="okpi-question-hint">
        {VIEWS.find(v => v.key === activeView)?.question}
      </div>
      {activeView === "failure" && <FailureAnalysis filterParams={filterParams} />}
      {activeView === "sponsors" && <SponsorPerformance filterParams={filterParams} />}
      {activeView === "enrollment" && <EnrollmentBenchmark filterParams={filterParams} />}
    </div>
  );
}
