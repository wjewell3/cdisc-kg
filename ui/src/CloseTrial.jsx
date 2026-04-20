/**
 * CloseTrial.jsx — Post-trial data readiness panels.
 *
 * Two views:
 * 1. Results Readiness — reporting rates, time-to-results, outcome completeness
 * 2. Statistical Profile — p-value distribution, endpoint significance
 *
 * Reacts to chart filters.
 */
import { useState, useEffect } from "react";

function trialsApiBase() {
  return import.meta.env.VITE_TRIALS_API_BASE || "";
}

function MiniBar({ data, title, maxItems = 10, valueLabel = "", highlightFn }) {
  const items = data.slice(0, maxItems);
  if (!items.length) return null;
  const maxVal = Math.max(...items.map(d => d.value), 1);
  return (
    <div className="okpi-chart">
      <div className="okpi-chart-title">{title}</div>
      {items.map((d) => (
        <div key={d.label} className="okpi-bar-row">
          <span className="okpi-bar-label" title={d.label}>
            {d.label.length > 32 ? d.label.slice(0, 30) + "…" : d.label}
          </span>
          <div className="okpi-bar-track">
            <div
              className="okpi-bar-fill"
              style={{
                width: `${Math.max((d.value / maxVal) * 100, 3)}%`,
                background: highlightFn ? highlightFn(d) : "#39d2c0",
              }}
            />
          </div>
          <span className="okpi-bar-count">
            {typeof d.value === "number" && d.value % 1 !== 0 ? d.value.toFixed(1) : d.value.toLocaleString()}
            {valueLabel}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function CloseTrial({ filterParams }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true); setError(null);
    const base = trialsApiBase();
    const url = new URL(base ? `${base}/api/results-readiness` : `/api/analytics`, window.location.origin);
    if (!base) url.searchParams.set("mode", "results-readiness");
    for (const [k, v] of Object.entries(filterParams)) { if (v) url.searchParams.set(k, v); }
    fetch(url.toString())
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => { if (!ok) throw new Error(d.error || "Failed"); setData(d); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [filterParams]);

  if (loading) return <div className="okpi-loading">Analyzing results readiness…</div>;
  if (error) return <div className="okpi-error">⚠ {error}</div>;
  if (!data) return null;

  const sig = data.statistical_significance;

  return (
    <div className="okpi-container">
      {/* ── KPI cards ── */}
      <div className="okpi-kpis" style={{ marginBottom: 16 }}>
        <div className="okpi-kpi">
          <div className="okpi-kpi-value">{data.total_completed.toLocaleString()}</div>
          <div className="okpi-kpi-label">Completed Trials</div>
        </div>
        <div className="okpi-kpi">
          <div className="okpi-kpi-value" style={{ color: data.reporting_rate_pct >= 50 ? "#58a6ff" : "#d29922" }}>
            {data.reporting_rate_pct != null ? `${data.reporting_rate_pct}%` : "—"}
          </div>
          <div className="okpi-kpi-label">Results Reported</div>
          <div className="okpi-kpi-sub">{data.results_reported.toLocaleString()} of {data.total_completed.toLocaleString()}</div>
        </div>
        <div className="okpi-kpi">
          <div className="okpi-kpi-value">{data.median_months_to_report ?? "—"}</div>
          <div className="okpi-kpi-label">Median Months to Report</div>
          <div className="okpi-kpi-sub">Avg: {data.avg_months_to_report ?? "—"} mo</div>
        </div>
        {sig?.total_analyses > 0 && (
          <div className="okpi-kpi">
            <div className="okpi-kpi-value" style={{ color: "#39d2c0" }}>
              {sig.significance_rate_pct}%
            </div>
            <div className="okpi-kpi-label">Significant (p&lt;0.05)</div>
            <div className="okpi-kpi-sub">{sig.significant.toLocaleString()} of {sig.total_analyses.toLocaleString()} analyses</div>
          </div>
        )}
      </div>

      {/* ── Outcome completeness — only show when snapshot data is available ── */}
      {data.outcomes && (data.outcomes.trials_with_planned > 0 || data.outcomes.trials_with_reported > 0) && (
        <div className="okpi-kpis" style={{ marginBottom: 16 }}>
          <div className="okpi-kpi">
            <div className="okpi-kpi-value">{data.outcomes.avg_planned?.toFixed(1) ?? "—"}</div>
            <div className="okpi-kpi-label">Avg Planned Outcomes</div>
            <div className="okpi-kpi-sub">{data.outcomes.trials_with_planned.toLocaleString()} trials</div>
          </div>
          <div className="okpi-kpi">
            <div className="okpi-kpi-value">{data.outcomes.avg_reported?.toFixed(1) ?? "—"}</div>
            <div className="okpi-kpi-label">Avg Reported Outcomes</div>
            <div className="okpi-kpi-sub">{data.outcomes.trials_with_reported.toLocaleString()} trials</div>
          </div>
        </div>
      )}

      <div className="okpi-charts-grid">
        {/* Reporting rate by phase */}
        {data.by_phase?.length > 0 && (
          <MiniBar
            data={data.by_phase.map(r => ({
              label: `${r.phase || "Unknown"} (n=${r.total})`,
              value: r.reporting_rate_pct ?? 0,
            }))}
            title="Results Reporting Rate by Phase"
            valueLabel="%"
            highlightFn={d => d.value >= 50 ? "#58a6ff" : "#d29922"}
          />
        )}

        {/* Reporting rate by sponsor */}
        {data.by_sponsor?.length > 0 && (
          <MiniBar
            data={data.by_sponsor.map(r => ({
              label: `${r.sponsor.length > 25 ? r.sponsor.slice(0, 23) + "…" : r.sponsor} (${r.avg_months ?? "—"}mo)`,
              value: r.reporting_rate_pct ?? 0,
            }))}
            title="Results Reporting Rate by Sponsor"
            valueLabel="%"
            maxItems={15}
            highlightFn={d => d.value >= 50 ? "#58a6ff" : "#d29922"}
          />
        )}
      </div>

      {/* ── Roadmap gap callout ── */}
      <div className="monitor-gap-callout">
        <div className="gap-callout-title">📋 Roadmap: What's Missing for Full DB-Lock Readiness</div>
        <div className="gap-callout-items">
          <span className="gap-item">Query aging &amp; open queries (EDC)</span>
          <span className="gap-item">SDV completion % (CTMS)</span>
          <span className="gap-item">LPLV → DB lock duration (CTMS)</span>
          <span className="gap-item">MedDRA / WHODrug coding status (EDC)</span>
        </div>
        <div className="gap-callout-note">These require EDC/CTMS integration — scoped as external data partnership workstream.</div>
      </div>
    </div>
  );
}
